import { basename } from 'node:path'
import type {
  ChatCommand,
  ProviderCapability,
} from '@reflexion-os-studio/contracts'
import { CommandError } from './agent/index.js'
import { streamChatCompletion } from './provider.js'
import { deleteSecret, loadSecret, saveSecret } from './secrets.js'
import {
  requireString,
  type CommandContext,
  type CommandHandler,
  type CommandResult,
} from './command-utils.js'
import { memoryCommandHandlers } from './handlers-memory.js'
import { builtinSkills } from './skills/index.js'

/**
 * 已通过 contracts schema 校验的命令分发。
 * 返回值即 JSON-RPC result；抛出 CommandError 转为业务错误响应。
 * memory.* 命令独立在 handlers-memory.ts，此处合并注册。
 */
const handlers: Record<string, CommandHandler> = {
  'project.list': (_params, { store }) => ({
    projects: store.projects.list(),
  }),
  'project.create': (p, { store }) => {
    // 去掉结尾分隔符再查重/落盘，避免同一文件夹因尾部斜杠重复建项。
    const folderPath = requireString(p, 'folderPath').replace(/[\\/]+$/, '')
    if (folderPath === '') {
      throw new CommandError('invalid_request', 'folderPath 不能为空')
    }
    const existing = store.projects.findByFolderPath(folderPath)
    if (existing) {
      throw new CommandError(
        'invalid_request',
        `该文件夹已关联项目：${existing.name}`,
      )
    }
    const name =
      typeof p.name === 'string' && p.name.trim() !== ''
        ? p.name.trim()
        : basename(folderPath) || folderPath
    return { project: store.projects.create({ name, folderPath }) }
  },
  'session.list': (p, { store }) => ({
    sessions: store.sessions.list(
      p.projectId === undefined
        ? undefined
        : p.projectId === null
          ? null
          : requireString(p, 'projectId'),
    ),
  }),
  'session.create': (p, { store }) => {
    const projectId =
      p.projectId === undefined || p.projectId === null
        ? null
        : requireString(p, 'projectId')
    if (projectId !== null && !store.projects.get(projectId)) {
      throw new CommandError(
        'invalid_request',
        `project not found: ${projectId}`,
      )
    }
    return {
      session: store.sessions.create(
        projectId,
        typeof p.title === 'string' && p.title !== '' ? p.title : undefined,
      ),
    }
  },
  'session.get': (p, { store }) => {
    const sessionId = requireString(p, 'sessionId')
    return {
      session: store.sessions.get(sessionId),
      messages: store.messages.listBySession(sessionId),
      runs: store.runs.listBySession(sessionId),
      toolCalls: store.toolCalls.listBySession(sessionId),
    }
  },
  'session.rename': (p, { store }) => {
    const sessionId = requireString(p, 'sessionId')
    const title = requireString(p, 'title').trim()
    if (title === '') {
      throw new CommandError('invalid_request', '标题不能为空')
    }
    if (!store.sessions.get(sessionId)) {
      throw new CommandError(
        'invalid_request',
        `session not found: ${sessionId}`,
      )
    }
    store.sessions.rename(sessionId, title)
    return { session: store.sessions.get(sessionId) }
  },
  'session.delete': (p, { store }) => {
    const sessionId = requireString(p, 'sessionId')
    // 有进行中的 Run 时拒绝删除，避免流式写入悬空会话。
    if (store.runs.activeForSession(sessionId)) {
      throw new CommandError(
        'invalid_request',
        '会话正在回复中，请先停止再删除',
      )
    }
    return {
      removed: store.transaction(() => {
        const removed = store.sessions.delete(sessionId)
        // memories.scope_id 无外键级联：会话删除时一并清理其记忆。
        if (removed) store.memories.removeByScope('session', sessionId)
        return removed
      }),
    }
  },
  'project.delete': (p, { store }) => {
    const projectId = requireString(p, 'projectId')
    const sessions = store.sessions.list(projectId)
    for (const session of sessions) {
      if (store.runs.activeForSession(session.id)) {
        throw new CommandError(
          'invalid_request',
          `项目内会话正在回复中（${session.title}），请先停止再删除`,
        )
      }
    }
    return {
      removed: store.transaction(() => {
        const removed = store.projects.delete(projectId)
        if (removed) {
          // 项目与其下会话的记忆都无外键级联，随删除主体一并清理。
          store.memories.removeByScope('project', projectId)
          for (const session of sessions) {
            store.memories.removeByScope('session', session.id)
          }
        }
        return removed
      }),
    }
  },
  'message.send': (p, { agent }) =>
    agent.startSend(p as unknown as ChatCommand),
  'run.cancel': (p, { agent }) => agent.cancel(requireString(p, 'runId')),
  'run.retry': (p, { agent }) =>
    agent.startRetry({
      requestId: requireString(p, 'requestId'),
      runId: requireString(p, 'runId'),
    }),
  'approval.resolve': (p, { approvals }) => ({
    accepted: approvals.resolve(
      requireString(p, 'toolCallId'),
      p.decision === 'denied' ? 'denied' : 'approved',
      p.scope === 'session' ? 'session' : 'once',
    ),
  }),
  'provider.list': (_p, { store }) => ({
    profiles: store.providers.list(),
  }),
  'provider.configure': (p, { store }) => {
    let secretRef =
      typeof p.secretRef === 'string' && p.secretRef !== ''
        ? p.secretRef
        : undefined
    if (typeof p.secret === 'string' && p.secret !== '') {
      // 明文 Key 只在此处出现一次，落盘后从内存语义上丢弃。
      secretRef = saveSecret(p.secret)
    }
    if (!secretRef) {
      throw new CommandError(
        'invalid_request',
        'provider.configure 需要 secret 或 secretRef',
      )
    }
    const models = (Array.isArray(p.models) ? p.models : [])
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item !== '')
    if (models.length === 0) {
      throw new CommandError(
        'invalid_request',
        'provider.configure 至少需要一个模型',
      )
    }
    const id = typeof p.id === 'string' && p.id !== '' ? p.id : undefined
    const existing = id ? store.providers.get(id) : null
    const profile = store.providers.upsert({
      id,
      name: requireString(p, 'name'),
      baseUrl: requireString(p, 'baseUrl'),
      models: [...new Set(models)],
      // capabilities 省略时由 store 保留原值（新建缺省 ['chat']）。
      capabilities: Array.isArray(p.capabilities)
        ? (p.capabilities as ProviderCapability[])
        : undefined,
      secretRef,
      enabled: p.enabled === undefined ? true : p.enabled === true,
    })
    // 换 Key 后清理被替换的旧密钥，secrets.json 不留孤儿条目。
    if (existing && existing.secretRef !== profile.secretRef) {
      deleteSecret(existing.secretRef)
    }
    return { profile }
  },
  'provider.delete': (p, { store }) => {
    const id = requireString(p, 'id')
    const profile = store.providers.get(id)
    if (!profile) return { removed: false }
    const removed = store.providers.delete(id)
    // 配置行已删则其密钥引用也不应残留；secret 文件里其余条目不受影响。
    deleteSecret(profile.secretRef)
    return { removed }
  },
  'skill.list': () => ({ skills: builtinSkills.list() }),
}

Object.assign(handlers, memoryCommandHandlers)

export function dispatchCommand(
  method: string,
  params: Record<string, unknown>,
  ctx: CommandContext,
): CommandResult {
  const handler = handlers[method]
  if (!handler) {
    throw new CommandError('unsupported', `unsupported command: ${method}`)
  }
  return handler(params, ctx)
}

/**
 * 供应商连接测试：发起一次 1 token 的补全，把 Provider 的
 * 鉴权/网络/模型错误原样返回给 UI（不落盘、不写库）。
 * 涉及网络等待，由 index.ts 异步调度、完成后单独回包。
 */
export async function testProviderConnection(
  params: Record<string, unknown>,
): Promise<CommandResult> {
  const baseUrl = requireString(params, 'baseUrl')
  const model = requireString(params, 'model')
  const secret =
    typeof params.secret === 'string' && params.secret !== ''
      ? params.secret
      : undefined
  const secretRef =
    typeof params.secretRef === 'string' && params.secretRef !== ''
      ? params.secretRef
      : undefined
  const apiKey = secret ?? (secretRef ? loadSecret(secretRef) : undefined)
  if (!apiKey) {
    throw new CommandError(
      'invalid_request',
      '缺少 API Key：请填写或先保存配置',
    )
  }
  const startedAt = Date.now()
  try {
    await streamChatCompletion(
      {
        baseUrl,
        apiKey,
        model,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 1,
        timeoutMs: 15_000,
        signal: new AbortController().signal,
      },
      () => {},
    )
    return { ok: true, latencyMs: Date.now() - startedAt, model, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model,
      error: message,
    }
  }
}
