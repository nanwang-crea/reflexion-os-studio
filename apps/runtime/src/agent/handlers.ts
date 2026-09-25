import { requireString, type CommandHandler } from '../command-utils.js'
import { CommandError } from './index.js'

/**
 * 委派生命周期只能由 Runtime 内部 task 工具创建和推进。
 * 外部写命令保留协议名用于兼容，但不得伪造父子 Run 或终态。
 */
function unsupportedDelegationWrite(): never {
  throw new CommandError(
    'unsupported',
    '委派写操作仅允许由 Runtime 内部 task 工具执行',
  )
}

/** 委派记录与 Agent 运行时设置命令（多 Agent 阶段的查询/配置面）。 */
export const agentCommandHandlers: Record<string, CommandHandler> = {
  'agent.list': (_p, { store }) => ({ agents: store.agents.list() }),
  'delegation.list': (p, { store }) => ({
    delegations: store.delegations.listBySession(requireString(p, 'sessionId')),
  }),
  'delegation.create': unsupportedDelegationWrite,
  'delegation.list_by_parent': (p, { store }) => ({
    delegations: store.delegations.listByParentRun(
      requireString(p, 'parentRunId'),
    ),
  }),
  'delegation.get_by_child_run': (p, { store }) => ({
    delegation: store.delegations.getByChildRun(requireString(p, 'childRunId')),
  }),
  'delegation.attach_child_run': unsupportedDelegationWrite,
  'delegation.update': unsupportedDelegationWrite,
  'agent_settings.get': (_p, { agent }) => agent.getSettings(),
  'agent_settings.update': (p, { agent }) =>
    agent.updateSettings(
      p.settings as Parameters<typeof agent.updateSettings>[0],
    ),
}
