import { basename } from 'node:path'
import type { ChatCommand } from '@reflexion-os-studio/contracts'
import type { ChatAgent } from './agent.js'
import { CommandError } from './agent.js'
import { streamChatCompletion } from './provider.js'
import { deleteSecret, loadSecret, saveSecret } from './secrets.js'
import type { Store } from './store.js'

type CommandResult = Record<string, unknown>

interface CommandContext {
  store: Store
  agent: ChatAgent
}

type CommandHandler = (
  params: Record<string, unknown>,
  ctx: CommandContext,
) => CommandResult

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value === '') {
    throw new CommandError('invalid_request', `missing param: ${key}`)
  }
  return value
}

/**
 * 已通过 contracts schema 校验的命令分发。
 * 返回值即 JSON-RPC result；抛出 CommandError 转为业务错误响应。
 */
export function dispatchCommand(
  method: string,
  params: Record<string, unknown>,
  ctx: CommandContext,
): CommandResult {
  const handlers: Record<string, CommandHandler> = {
    'project.list': (_params, { store }) => ({
      projects: store.listProjects(),
    }),
    'project.create': (p, { store }) => {
      // 去掉结尾分隔符再查重/落盘，避免同一文件夹因尾部斜杠重复建项。
      const folderPath = requireString(p, 'folderPath').replace(/[\\/]+$/, '')
      if (folderPath === '') {
        throw new CommandError('invalid_request', 'folderPath 不能为空')
      }
      const existing = store.findProjectByFolderPath(folderPath)
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
      return { project: store.createProject({ name, folderPath }) }
    },
    'session.list': (p, { store }) => ({
      sessions: store.listSessions(
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
      if (projectId !== null && !store.getProject(projectId)) {
        throw new CommandError(
          'invalid_request',
          `project not found: ${projectId}`,
        )
      }
      return {
        session: store.createSession(
          projectId,
          typeof p.title === 'string' && p.title !== '' ? p.title : undefined,
        ),
      }
    },
    'session.get': (p, { store }) => {
      const sessionId = requireString(p, 'sessionId')
      return {
        session: store.getSession(sessionId),
        messages: store.getSessionMessages(sessionId),
        runs: store.getSessionRuns(sessionId),
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
    'provider.list': (_p, { store }) => ({
      profiles: store.listProviderProfiles(),
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
      const profile = store.upsertProviderProfile({
        id: typeof p.id === 'string' && p.id !== '' ? p.id : undefined,
        name: requireString(p, 'name'),
        baseUrl: requireString(p, 'baseUrl'),
        models: [...new Set(models)],
        secretRef,
        enabled: p.enabled === undefined ? true : p.enabled === true,
      })
      return { profile }
    },
    'provider.delete': (p, { store }) => {
      const id = requireString(p, 'id')
      const profile = store.getProviderProfile(id)
      if (!profile) return { removed: false }
      const removed = store.deleteProviderProfile(id)
      // 配置行已删则其密钥引用也不应残留；secret 文件里其余条目不受影响。
      deleteSecret(profile.secretRef)
      return { removed }
    },
  }

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
