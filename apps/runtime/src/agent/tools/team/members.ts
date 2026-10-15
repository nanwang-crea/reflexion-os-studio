import { createHash } from 'node:crypto'
import type { AgentTemplate } from '@reflexion-os-studio/contracts'
import type { ToolContext } from '../shared.js'

export function teamProjectId(
  ctx: Pick<ToolContext, 'store' | 'projectId'>,
  scope: 'project' | 'global',
) {
  if (scope === 'project' && !ctx.projectId)
    throw new Error('当前会话没有项目，请使用全局范围')
  return scope === 'project' ? ctx.projectId : null
}

export function teamMembers(
  ctx: Pick<ToolContext, 'store' | 'projectId'>,
  projectId: string | null,
  teamId: string,
): AgentTemplate[] {
  return ctx.store.agents
    .list(projectId)
    .filter(
      (role) =>
        role.projectId === projectId && role.domains.includes(`team:${teamId}`),
    )
}

export function teamRevision(members: AgentTemplate[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify([...members].sort((a, b) => a.id.localeCompare(b.id))),
    )
    .digest('hex')
}

/** Shared templates survive removal from one team; exclusive members are deleted. */
export function removeTeamMember(
  ctx: Pick<ToolContext, 'store' | 'projectId'>,
  role: AgentTemplate,
  teamId: string,
) {
  const domains = role.domains.filter((domain) => domain !== `team:${teamId}`)
  if (!domains.some((domain) => domain.startsWith('team:'))) {
    ctx.store.agents.removeUser(role.id)
    return { id: role.id, name: role.name, action: 'deleted' }
  }
  ctx.store.agents.saveUser({
    ...role,
    domains,
    permissionCeiling: role.policy.permissionCeiling,
    allowedTools: role.policy.allowedTools,
    canDelegate: role.policy.canDelegate,
  })
  return { id: role.id, name: role.name, action: 'detached' }
}
