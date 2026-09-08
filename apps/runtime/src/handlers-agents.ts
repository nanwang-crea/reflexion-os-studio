import { requireString, type CommandHandler } from './command-utils.js'

/** 委派记录与 Agent 运行时设置命令（多 Agent 阶段的查询/配置面）。 */
export const agentCommandHandlers: Record<string, CommandHandler> = {
  'agent.list': (_p, { store }) => ({ agents: store.agents.list() }),
  'delegation.list': (p, { store }) => ({
    delegations: store.delegations.listBySession(requireString(p, 'sessionId')),
  }),
  'delegation.create': (p, { store }) => ({
    delegation: store.delegations.create({
      sessionId: requireString(p, 'sessionId'),
      parentRunId: requireString(p, 'parentRunId'),
      agentId: requireString(p, 'agentId'),
      task: requireString(p, 'task'),
    }),
  }),
  'delegation.list_by_parent': (p, { store }) => ({
    delegations: store.delegations.listByParentRun(
      requireString(p, 'parentRunId'),
    ),
  }),
  'delegation.get_by_child_run': (p, { store }) => ({
    delegation: store.delegations.getByChildRun(requireString(p, 'childRunId')),
  }),
  'delegation.attach_child_run': (p, { store }) => ({
    delegation: store.delegations.attachChildRun(
      requireString(p, 'delegationId'),
      requireString(p, 'childRunId'),
    ),
  }),
  'delegation.update': (p, { store }) => ({
    delegation: store.delegations.update(
      requireString(p, 'delegationId'),
      p.status as Parameters<typeof store.delegations.update>[1],
      p.result as string | null | undefined,
      p.error as string | null | undefined,
    ),
  }),
  'agent_settings.get': (_p, { agent }) => agent.getSettings(),
  'agent_settings.update': (p, { agent }) =>
    agent.updateSettings(
      p.settings as Parameters<typeof agent.updateSettings>[0],
    ),
}
