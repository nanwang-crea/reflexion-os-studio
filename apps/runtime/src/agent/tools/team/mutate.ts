import {
  AgentTeamUpdateInputSchema,
  AgentTeamDeleteInputSchema,
  agentTeamToolParameters,
  type JsonValue,
} from '@reflexion-os-studio/contracts'
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { ToolContext } from '../shared.js'
import { requirePrimaryTeamAccess } from './access.js'
import { prepareTeamRole } from './validation.js'
import {
  teamMembers,
  teamProjectId,
  teamRevision,
  removeTeamMember,
} from './members.js'

export function createTeamMutationTool(
  ctx: ToolContext,
  operation: 'update' | 'delete',
): ToolDefinition {
  return {
    name: `agent_team.${operation}`,
    description:
      operation === 'update'
        ? '经逐次审批增量修改已有团队。先 inspect 获取 expectedRevision；roles 为完整角色配置，带 id 修改现有成员，不带 id 新增，未提及成员保留。removeRoleIds 显式移除成员：独占模板删除，多团队模板仅解除本团队。domains 可省略团队标签，也可保留 inspect 返回的原有标签；成员关系自动维护，不能手动加入其他团队。共享角色修改会影响其他团队。保留历史和运行中实例。'
        : '经逐次审批删除指定范围的团队。先 inspect 获取 expectedRevision。独占角色模板删除，多团队角色仅解除本团队关系；保留历史与运行中实例。',
    parameters: agentTeamToolParameters[operation] as JsonValue,
    execution: { effect: 'state', idempotent: false },
    execute({ args, signal }) {
      requirePrimaryTeamAccess(ctx)
      if (ctx.store.sessions.get(ctx.sessionId)?.executionMode === 'plan')
        throw new Error('计划模式不允许修改或删除团队角色')
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const input =
        operation === 'update'
          ? AgentTeamUpdateInputSchema.parse(args)
          : AgentTeamDeleteInputSchema.parse(args)
      const projectId = teamProjectId(ctx, input.scope)
      const data = ctx.store.transaction(() => {
        const members = teamMembers(ctx, projectId, input.teamId)
        if (!members.length) throw new Error('该范围的团队不存在')
        if (teamRevision(members) !== input.expectedRevision)
          throw new Error(
            '团队配置已变化，请重新 inspect 并审批，未应用任何修改',
          )
        if (members.some((role) => role.builtin))
          throw new Error('内置角色不可修改或删除')
        const changes =
          operation === 'update'
            ? AgentTeamUpdateInputSchema.parse(input)
            : null
        const removeIds =
          changes?.removeRoleIds ?? members.map((role) => role.id)
        const updates = changes?.roles ?? []
        if (operation === 'update' && !updates.length && !removeIds.length)
          throw new Error('请指定需要新增、修改或移除的角色')
        const ids = [
          ...removeIds,
          ...updates.flatMap((role) => (role.id ? [role.id] : [])),
        ]
        if (new Set(ids).size !== ids.length)
          throw new Error('角色 ID 不得重复或同时修改和移除')
        if (ids.some((id) => !members.some((role) => role.id === id)))
          throw new Error('只能修改或移除该范围团队的现有成员')
        const prepared = updates.map(({ id, ...role }) => {
          const current = members.find((member) => member.id === id)
          const value = prepareTeamRole(
            ctx,
            role,
            projectId,
            input.teamId,
            current?.domains,
            current?.skills,
          )
          return { ...value, ...(id ? { id } : {}) }
        })
        const retained = members.filter((role) => !ids.includes(role.id))
        const names = [
          ...retained.map((role) => role.name),
          ...prepared.map((role) => role.name),
        ]
        if (names.length > 8) throw new Error('团队最多保留 8 个角色')
        if (new Set(names).size !== names.length)
          throw new Error('团队角色名称必须唯一')
        const removed = members
          .filter((role) => removeIds.includes(role.id))
          .map((role) => removeTeamMember(ctx, role, input.teamId))
        const templates = prepared.map((role) =>
          ctx.store.agents.saveUser(role),
        )
        const remaining = teamMembers(ctx, projectId, input.teamId)
        return {
          teamId: input.teamId,
          projectId,
          templates,
          removed,
          deleted: remaining.length === 0,
          revision: teamRevision(remaining),
        }
      })
      return { content: JSON.stringify(data), data, isError: false }
    },
  }
}
