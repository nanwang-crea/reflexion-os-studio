import type {
  ApprovalGrantV2,
  SandboxPolicy,
} from '@reflexion-os-studio/contracts'

/**
 * ApprovalGrantV2 签发（§11.1）：无论来源（once / session-rule / preset /
 * danger-lease）都为当前实际请求签发短期 grant；Rust 按 operation +
 * subjectDigest 重算复核。grant JSON 不进事件 payload、不落审计日志。
 */

/** once/preset/danger 单调用时效 5 分钟；session-rule 引用时效 30 分钟。 */
const ONCE_TTL_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000
export interface GrantInput {
  grantId: string
  requestId: string
  sessionId: string
  workspaceRoot: string | null
  operation: string
  source: ApprovalGrantV2['source']
  subjectDigest: string
  sandbox: SandboxPolicy
  /** escalated 档的审批提权根（参与 digest；其余档位省略）。 */
  escalationRoots?: string[]
  sandboxNetwork: boolean
  /** danger-lease 签发时不得超过租约到期时间。 */
  notAfter?: number
}

export function buildGrantV2(input: GrantInput, now = Date.now()): string {
  const baseTtl = input.source === 'session-rule' ? SESSION_TTL_MS : ONCE_TTL_MS
  const expiresAt =
    input.notAfter === undefined
      ? now + baseTtl
      : Math.min(now + baseTtl, input.notAfter)
  const grant: ApprovalGrantV2 = {
    version: 2,
    grantId: input.grantId,
    requestId: input.requestId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceRoot ?? '',
    operation: input.operation,
    source: input.source,
    subjectDigest: input.subjectDigest,
    sandbox: input.sandbox,
    ...(input.escalationRoots && input.escalationRoots.length > 0
      ? { escalationRoots: input.escalationRoots }
      : {}),
    sandboxNetwork: input.sandboxNetwork,
    expiresAt,
  }
  return JSON.stringify(grant)
}
