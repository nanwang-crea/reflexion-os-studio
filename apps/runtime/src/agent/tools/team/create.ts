import {
  AgentTeamCreateInputSchema,
  agentTeamToolParameters,
  type JsonValue,
} from '@reflexion-os-studio/contracts'
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { ToolContext } from '../shared.js'
import { prepareTeamRole } from './validation.js'
import { requirePrimaryTeamAccess } from './access.js'

export function createTeamCreateTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'agent_team.create',
    description:
      '经用户审批，将明确职责、输入输出、交接与验收要求的角色批量保存为团队。scope 为当前项目或全局；不会覆盖已有团队。未指定模型继承会话模型，权限默认 workspace-read。配置只能收窄实际执行权限。',
    parameters: agentTeamToolParameters.create as JsonValue,
    execution: { effect: 'state', idempotent: false },
    execute({ args, signal }) {
      requirePrimaryTeamAccess(ctx)
      if (ctx.store.sessions.get(ctx.sessionId)?.executionMode === 'plan')
        throw new Error('计划模式不允许保存团队角色')
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const input = AgentTeamCreateInputSchema.parse(args)
      const projectId = input.scope === 'project' ? ctx.projectId : null
      if (input.scope === 'project' && !projectId)
        throw new Error('当前会话没有项目，请使用全局范围')
      const tag = `team:${input.teamId}`
      if (
        ctx.store.agents
          .list(projectId)
          .some(
            (role) =>
              role.projectId === projectId && role.domains.includes(tag),
          )
      )
        throw new Error(
          '该范围的团队已存在，请先 inspect 再使用 agent_team.update 修改',
        )
      if (
        new Set(input.roles.map((role) => role.name)).size !==
        input.roles.length
      )
        throw new Error('团队角色名称必须唯一')
      const roles = input.roles.map((role) =>
        prepareTeamRole(ctx, role, projectId, input.teamId),
      )
      const templates = ctx.store.transaction(() =>
        roles.map((role) => ctx.store.agents.saveUser(role)),
      )
      const data = { teamId: input.teamId, projectId, templates }
      const content = JSON.stringify({
        ...data,
        templates: templates.map((template) => ({
          id: template.id,
          name: template.name,
          projectId: template.projectId,
          domains: template.domains,
          modelBinding: template.modelBinding,
          policy: template.policy,
          enabled: template.enabled,
        })),
      })
      return { content, data, isError: false }
    },
  }
}
