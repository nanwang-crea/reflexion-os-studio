import type { ChatCommand } from '@reflexion-os-studio/contracts'
import type { ChatAgent } from './agent.js'
import { CommandError } from './agent.js'
import { saveSecret } from './secrets.js'
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
    'project.create': (p, { store }) => ({
      project: store.createProject(requireString(p, 'name')),
    }),
    'session.list': (p, { store }) => ({
      sessions: store.listSessions(requireString(p, 'projectId')),
    }),
    'session.create': (p, { store }) => ({
      session: store.createSession(
        requireString(p, 'projectId'),
        typeof p.title === 'string' && p.title !== '' ? p.title : undefined,
      ),
    }),
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
      const profile = store.upsertProviderProfile({
        id: typeof p.id === 'string' && p.id !== '' ? p.id : undefined,
        name: requireString(p, 'name'),
        baseUrl: requireString(p, 'baseUrl'),
        model: requireString(p, 'model'),
        secretRef,
        enabled: p.enabled === undefined ? true : p.enabled === true,
      })
      return { profile }
    },
  }

  const handler = handlers[method]
  if (!handler) {
    throw new CommandError('unsupported', `unsupported command: ${method}`)
  }
  return handler(params, ctx)
}
