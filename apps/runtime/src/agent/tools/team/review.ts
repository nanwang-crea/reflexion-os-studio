import {
  AgentTeamCreateInputSchema,
  type JsonValue,
} from '@reflexion-os-studio/contracts'
import { containsSecretLike } from '../../instructions/secretGuard.js'
import { redactSecrets } from '../../permissions/summaries.js'

/** Approval previews come from actual validated arguments, never model commentary. */
export function teamApprovalReview(args: JsonValue): string | undefined {
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
