import {
  AgentTeamCreateInputSchema,
  AgentTeamUpdateInputSchema,
  AgentTeamDeleteInputSchema,
  type JsonValue,
} from '@reflexion-os-studio/contracts'
import type { ToolContext } from '../shared.js'
import { teamMembers, teamProjectId } from './members.js'
import { containsSecretLike } from '../../instructions/secretGuard.js'
import { redactSecrets } from '../../permissions/summaries.js'

/** Approval previews come from actual validated arguments, never model commentary. */
export function teamApprovalReview(
  args: JsonValue,
  operation = 'agent_team.create',
  ctx?: Pick<ToolContext, 'store' | 'projectId'>,
): string | undefined {
  if (operation !== 'agent_team.create') {
    const parsed = (
      operation === 'agent_team.update'
        ? AgentTeamUpdateInputSchema
        : AgentTeamDeleteInputSchema
    ).safeParse(args)
    if (!parsed.success) return undefined
    const update =
      operation === 'agent_team.update'
        ? AgentTeamUpdateInputSchema.safeParse(args)
        : null
    if (
      update?.success &&
      update.data.roles.some((role) =>
        [role.name, role.description, role.systemPrompt, ...role.domains].some(
          containsSecretLike,
        ),
      )
    )
      return '配置疑似包含机密，保存工具会拒绝执行。'
    const currentMembers = ctx
      ? teamMembers(
          ctx,
          teamProjectId(ctx, parsed.data.scope),
          parsed.data.teamId,
        )
      : []
    const source = JSON.stringify(
      {
        operation,
        ...parsed.data,
        ...(update?.success
          ? {
              roles: update.data.roles.map((role) => ({
                ...role,
                domains: [
                  ...role.domains,
                  ...(currentMembers
                    .find((member) => member.id === role.id)
                    ?.domains.filter((domain) =>
                      domain.startsWith('team:'),
                    ) ?? [`team:${parsed.data.teamId}`]),
                ],
                modelBinding: role.modelBinding ?? { mode: 'inherit' },
                permissionCeiling: role.permissionCeiling ?? 'workspace-read',
              })),
            }
          : {}),
        currentMembers,
        removalPolicy:
          '独占角色模板删除；多团队模板仅解除当前团队关系。共享模板的配置修改会影响所有引用团队。历史和运行中实例保留。',
      },
      null,
      2,
    )
    return source.split('\n').map(redactSecrets).join('\n')
  }
  const parsed = AgentTeamCreateInputSchema.safeParse(args)
  if (!parsed.success) return undefined
  const source = JSON.stringify(
    {
      ...parsed.data,
      roles: parsed.data.roles.map((role) => ({
        ...role,
        domains: [...role.domains, `team:${parsed.data.teamId}`],
        modelBinding: role.modelBinding ?? { mode: 'inherit' },
        permissionCeiling: role.permissionCeiling ?? 'workspace-read',
      })),
    },
    null,
    2,
  )
  if (
    parsed.data.roles.some((role) =>
      [role.name, role.description, role.systemPrompt, ...role.domains].some(
        containsSecretLike,
      ),
    )
  )
    return '配置疑似包含机密，保存工具会拒绝执行。'
  return source.split('\n').map(redactSecrets).join('\n')
}
