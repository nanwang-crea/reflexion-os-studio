import type { AgentTeamCreateInput } from '@reflexion-os-studio/contracts'
import type { ToolContext } from '../shared.js'
import { INHERITABLE_CHILD_TOOLS } from '../../delegation/instance.js'
import { validateRoleTemplate } from '../../templates/validation.js'

/** Membership tags are managed here, including inspect → update round trips. */
export function teamRoleDomains(
  domains: string[],
  teamId: string,
  currentDomains: string[] = [],
): string[] {
  const tag = `team:${teamId}`
  const memberships = currentDomains.filter((domain) =>
    domain.startsWith('team:'),
  )
  if (
    domains.some(
      (domain) =>
        domain.startsWith('team:') &&
        domain !== tag &&
        !memberships.includes(domain),
    )
  )
    throw new Error(
      '不能通过 domains 添加其他团队关系；请仅填写领域或保留 inspect 返回的原有团队标签',
    )
  const result = [
    ...new Set([
      ...domains.filter((domain) => !domain.startsWith('team:')),
      tag,
      ...memberships,
    ]),
  ]
  if (result.length > 12)
    throw new Error(
      '角色领域数量超过上限（包含自动维护的团队标签，最多 12 项）',
    )
  return result
}

export function prepareTeamRole(
  ctx: ToolContext,
  role: AgentTeamCreateInput['roles'][number],
  projectId: string | null,
  teamId: string,
  currentDomains: string[] = [],
) {
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
    domains: teamRoleDomains(role.domains, teamId, currentDomains),
    permissionCeiling: role.permissionCeiling ?? ('workspace-read' as const),
    modelBinding: role.modelBinding ?? { mode: 'inherit' as const },
  }
  validateRoleTemplate(ctx.store, value)
  return value
}
