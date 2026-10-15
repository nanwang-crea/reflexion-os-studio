import {
  AgentTeamInspectInputSchema,
  agentTeamToolParameters,
  DEFAULT_REASONING_OPTIONS,
  type JsonValue,
} from '@reflexion-os-studio/contracts'
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { ToolContext } from '../shared.js'
import { INHERITABLE_CHILD_TOOLS } from '../../delegation/instance.js'
import { requirePrimaryTeamAccess } from './access.js'

export function createTeamInspectTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'agent_team.inspect',
    description:
      '查询当前项目可见的团队、完整角色职责与工具权限，以及可用模型能力。角色配置在应用存储中，无需搜索工作区角色文件；不返回任何凭据。',
    parameters: agentTeamToolParameters.inspect as JsonValue,
    execution: { effect: 'read', resourceKeys: () => [] },
    execute({ args }) {
      requirePrimaryTeamAccess(ctx)
      const input = AgentTeamInspectInputSchema.parse(args)
      const templates = ctx.store.agents
        .list(ctx.projectId)
        .filter(
          (template) =>
            (!input.templateId || template.id === input.templateId) &&
            (!input.teamId ||
              template.domains.includes(`team:${input.teamId}`)),
        )
      const groups = new Map<
        string,
        { teamId: string; projectId: string | null; templateIds: string[] }
      >()
      for (const template of templates) {
        for (const domain of template.domains.filter((domain) =>
          domain.startsWith('team:'),
        )) {
          const teamId = domain.slice(5)
          const key = JSON.stringify([template.projectId, teamId])
          const group = groups.get(key) ?? {
            teamId,
            projectId: template.projectId,
            templateIds: [],
          }
          group.templateIds.push(template.id)
          groups.set(key, group)
        }
      }
      const models = ctx.store.providers
        .list()
        .filter(
          (profile) => profile.enabled && profile.capabilities.includes('chat'),
        )
        .flatMap((profile) =>
          profile.models.map((model) => {
            const config = ctx.store.providerModels.get(profile.id, model)
            const supported = Boolean(
              config?.reasoningEffortSupported &&
              profile.apiFormat !== 'anthropic',
            )
            return {
              providerId: profile.id,
              providerName: profile.name,
              model,
              reasoningEffortSupported: supported,
              reasoningOptions: supported
                ? (config?.reasoningOptions ?? DEFAULT_REASONING_OPTIONS)
                : [],
            }
          }),
        )
      const data = {
        projectId: ctx.projectId,
        workspaceRoot: ctx.workspaceRoot,
        teams: [...groups.values()],
        templates,
        models,
        browserAvailable: Boolean(ctx.browser?.enabled),
        delegationLimits: ctx.store.agentSettings.get(),
        delegatableTools: [
          ...INHERITABLE_CHILD_TOOLS,
          ...(ctx.mcp
            ?.allTools()
            .map((tool) => `${tool.serverId}/${tool.toolName}`) ?? []),
        ],
        templateSelection:
          '用户在会话指定的默认模板优先于 task 的 templateId；多角色团队建议使用自动选择。',
      }
      return { content: JSON.stringify(data), data, isError: false }
    },
  }
}
