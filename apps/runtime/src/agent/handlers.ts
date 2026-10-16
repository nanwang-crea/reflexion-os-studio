import { rolePackageHandlers } from './templates/package/handlers.js'
import { resolveRoleSkills } from './templates/skills.js'
import { exportTeam, importTeam } from './templates/team-share.js'
import { bulkUpdateTemplates } from './templates/bulk.js'
import { validateRoleTemplate } from './templates/validation.js'
import { agentTemplateCommands } from '@reflexion-os-studio/contracts'
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
  'agent.set_enabled': (p, { store }) => {
    const agent = store.agents.setEnabled(
      requireString(p, 'agentId'),
      p.enabled === true,
    )
    if (!agent) throw new CommandError('not_found', 'Agent 不存在')
    return { agent }
  },
  'agent_template.team_export': (p, { store }) => exportTeam(p, store),
  'agent_template.team_import': (p, { store, plugins }) =>
    importTeam(p, store, plugins?.registry),
  ...rolePackageHandlers,
  'agent_template.list': (p, { store }) => ({
    templates: store.agents.list(
      agentTemplateCommands['agent_template.list'].params.parse(p).projectId,
    ),
  }),
  'agent_template.save': (p, { store, plugins }) => {
    try {
      const input = agentTemplateCommands['agent_template.save'].params.parse(p)
      validateRoleTemplate(store, input)
      const current = input.id ? store.agents.get(input.id) : null
      if ((input.skills ?? current?.skills ?? []).length)
        resolveRoleSkills(
          {
            ...input,
            skills: input.skills ?? current?.skills,
            projectId:
              input.projectId === undefined
                ? current?.projectId
                : input.projectId,
          },
          plugins.registry,
        )
      return { template: store.agents.saveUser(input) }
    } catch (error) {
      throw new CommandError(
        'invalid_request',
        error instanceof Error ? error.message : String(error),
      )
    }
  },
  'agent_template.bulk_update': (p, { store, plugins }) =>
    bulkUpdateTemplates(p, store, plugins?.registry),
  'agent_template.remove': (p, { store }) => ({
    removed: store.agents.removeUser(requireString(p, 'templateId')),
  }),
  'delegation.list': (p, { store }) => ({
    delegations: store.delegations.listBySession(requireString(p, 'sessionId')),
  }),
  'delegation.create': unsupportedDelegationWrite,
  'delegation.list_by_parent': (p, { store }) => ({
    delegations: store.delegations.listByParentRun(
      requireString(p, 'parentRunId'),
    ),
  }),
  'delegation.tree': (p, { store }) => ({
    delegations: store.delegations.listByRootRun(requireString(p, 'rootRunId')),
  }),
  'mutation_receipt.list': (p, { store }) => ({
    receipts: store.mutationReceipts.listByRootRun(
      requireString(p, 'rootRunId'),
    ),
  }),
  'delegation.get_by_child_run': (p, { store }) => ({
    delegation: store.delegations.getByChildRun(requireString(p, 'childRunId')),
  }),
  'delegation.cancel': (p, { agent }) =>
    agent.cancelDelegation(requireString(p, 'delegationId')),
  'delegation.attach_child_run': unsupportedDelegationWrite,
  'delegation.update': unsupportedDelegationWrite,
  'agent_settings.get': (_p, { agent }) => agent.getSettings(),
  'agent_settings.update': (p, { agent }) =>
    agent.updateSettings(
      p.settings as Parameters<typeof agent.updateSettings>[0],
    ),
}
