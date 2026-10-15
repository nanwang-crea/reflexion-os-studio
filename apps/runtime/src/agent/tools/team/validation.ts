import type { AgentTeamCreateInput } from '@reflexion-os-studio/contracts'
import type { ToolContext } from '../shared.js'
import { INHERITABLE_CHILD_TOOLS } from '../../delegation/instance.js'
import { validateRoleTemplate } from '../../templates/validation.js'

export function prepareTeamRole(
  ctx: ToolContext,
  role: AgentTeamCreateInput['roles'][number],
  projectId: string | null,
  teamId: string,
) {
  if (role.domains.some((domain) => domain.startsWith('team:')))
    throw new Error('团队成员关系由 teamId 管理，请勿在 domains 中指定')
  const mcpTools = new Set(
    ctx.mcp?.allTools().map((tool) => `${tool.serverId}/${tool.toolName}`) ??
      [],
  )
  if (
    role.allowedTools.some(
      (tool) => !INHERITABLE_CHILD_TOOLS.includes(tool) && !mcpTools.has(tool),
    )
  )
    throw new Error('角色包含不可委派或未知工具，请检查工具配置')
  if (role.canDelegate && !role.allowedTools.includes('task'))
    throw new Error('允许继续委派的角色必须包含 task 工具')
  const value = {
    ...role,
    projectId,
    domains: [...role.domains, `team:${teamId}`],
    permissionCeiling: role.permissionCeiling ?? ('workspace-read' as const),
    modelBinding: role.modelBinding ?? { mode: 'inherit' as const },
  }
  validateRoleTemplate(ctx.store, value)
  return value
}
