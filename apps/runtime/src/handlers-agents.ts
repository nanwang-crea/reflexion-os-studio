import { requireString, type CommandHandler } from './command-utils.js'
import { CommandError } from './agent/index.js'

/**
 * Phase 3 未启动：委派写命令统一拒绝。数据表与查询命令保留用于历史诊断，
 * 不破坏兼容；正式启用需先完成 Phase 3 设计评审。
 */
function unsupportedDelegationWrite(): never {
  throw new CommandError(
    'unsupported',
    '子 Agent 委派属 Phase 3，当前未开放写操作',
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
