import { z } from 'zod'
import { SandboxPolicySchema, ToolOperationSchema } from './entities.js'

/**
 * 权限模型 V2（Codex 风格）契约唯一真源：
 * 审批主题（subject）、choice 驱动的审批协议、Sandbox 档位、
 * Danger 会话租约与 shell.execute 工具参数。
 * 档位枚举（PermissionPreset/ApprovalOverride/SandboxPolicy）在 entities.ts，
 * 避免与 QueueEntrySchema 形成模块环。
 */

/** 审批风险分层：UI 视觉与文案据此选择，不允许只靠颜色区分。 */
export const ApprovalRiskSchema = z.enum([
  'normal',
  'warning',
  'elevated',
  'danger-confirm',
])
export type ApprovalRisk = z.infer<typeof ApprovalRiskSchema>

/**
 * 审批主题：Runtime 依工具参数构造，模型不得直接提供。
 * 授权身份用 kind + 结构化字段（digest/规则），displayCommand 仅供 UI。
 */
export const ApprovalSubjectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('operation'),
    operation: z.string().min(1),
  }),
  z.object({
    kind: z.literal('workspace-path'),
    operation: ToolOperationSchema,
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal('shell-command'),
    operation: z.literal('shell.execute'),
    commandDigest: z.string().min(1),
    displayCommand: z.string(),
    prefixCandidate: z.array(z.string().min(1)).nullable(),
    escalation: z.boolean(),
    network: z.boolean(),
  }),
])
export type ApprovalSubject = z.infer<typeof ApprovalSubjectSchema>

/**
 * Runtime 认可的审批选项；前端只能回传 choiceId，不得由 label/presentation
 * 反推构造授权规则。真实 effect（写哪条 session rule、什么档位）只在 Runtime 侧。
 */
export const ApprovalChoiceSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
  // primary=主按钮；session-menu=「始终允许…」菜单项；secondary=次级按钮。
  presentation: z.enum(['primary', 'session-menu', 'secondary']),
  label: z.string().min(1),
  description: z.string().optional(),
})
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>

/** Run 所属 Agent 的脱敏展示信息；审批与结构化提问共用。 */
export const AgentContextSchema = z.object({
  instanceId: z.string().min(1).nullable(),
  displayName: z.string().min(1),
  depth: z.number().int().nonnegative().max(4),
  rootRunId: z.string().min(1),
  rootTask: z.string().min(1),
})
export type AgentContextView = z.infer<typeof AgentContextSchema>

/** 审批上下文：脱敏后的执行环境描述，供 UI 以短标签展示。 */
export const ApprovalContextSchema = z.object({
  displayCwd: z.string().nullable(),
  workspaceScope: z.enum(['inside', 'outside', 'none']),
  sandbox: SandboxPolicySchema,
  sandboxProvider: z.string().nullable(),
  network: z.boolean(),
  escalation: z.boolean(),
  justification: z.string().nullable(),
  agent: AgentContextSchema.optional(),
})
export type ApprovalContextView = z.infer<typeof ApprovalContextSchema>

/** 执行平台实际解释器：分类器与执行器必须同批切换，禁止不一致。 */
export const ShellInterpreterSchema = z.enum(['posix-sh', 'windows-cmd'])
export type ShellInterpreter = z.infer<typeof ShellInterpreterSchema>

/**
 * 精确调用 grant V2：无论来源（once/session-rule/preset/danger-lease）都为
 * 当前实际请求签发短期凭据；Rust 按 operation + subjectDigest 复核。
 * grant JSON 不进事件 payload、不落审计日志。
 */
export const ApprovalGrantV2Schema = z.object({
  version: z.literal(2),
  grantId: z.string().min(1),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  // 工作区根路径（workspaceId 沿用 Rust 侧既有字段名）；无工作区为空串。
  workspaceId: z.string(),
  operation: z.string().min(1),
  source: z.enum(['once', 'session-rule', 'preset', 'danger-lease']),
  subjectDigest: z.string().min(1),
  sandbox: SandboxPolicySchema,
  // escalated 档的审批提权根：参与 digest（Rust 重算绑定），Rust 再独立
  // 复核绝对性/深度/敏感重叠。其它档位必须为空。
  escalationRoots: z.array(z.string().min(1).max(4096)).max(8).optional(),
  sandboxNetwork: z.boolean(),
  expiresAt: z.number().int().nonnegative(),
})
export type ApprovalGrantV2 = z.infer<typeof ApprovalGrantV2Schema>

/** Danger enforcement 提供方（三平台各自的可验证硬边界）。 */
export const DangerProviderSchema = z.enum([
  'seatbelt',
  'bwrap',
  'windows-guard',
])
export type DangerProvider = z.infer<typeof DangerProviderSchema>

/**
 * 平台 Danger capability：supported=false 时 enable 必须 fail-closed
 * （尤其 Windows：无可验证凭据拒读机制前不得启用）。
 */
export const DangerCapabilitySchema = z.object({
  supported: z.boolean(),
  provider: DangerProviderSchema.nullable(),
  // 不可用原因 / 降级说明；UI 直接展示，不含机密。
  detail: z.string().nullable(),
})
export type DangerCapability = z.infer<typeof DangerCapabilitySchema>

/** Danger 会话租约：内存态，最长 30 分钟，重启/会话删除/到期/关闭即失效。 */
export const DangerAccessLeaseSchema = z.object({
  sessionId: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  enforcement: z.literal('credential-guard'),
  provider: DangerProviderSchema,
})
export type DangerAccessLease = z.infer<typeof DangerAccessLeaseSchema>

/** Danger lease 撤销原因（审计与 danger.changed 事件用）。 */
export const DangerRevokeReasonSchema = z.enum([
  'user-disabled',
  'expired',
  'session-deleted',
  'runtime-restart',
  'provider-degraded',
  'guard-selfcheck-failed',
])
export type DangerRevokeReason = z.infer<typeof DangerRevokeReasonSchema>

/**
 * shell.execute 模型可见参数的协议真源（snake_case = 模型面）。
 * 约束：require_escalated 必须携带非空 justification；
 * prefix_rule 只是审批候选，Runtime 验证与实际命令 token 匹配。
 */
export const ShellExecuteParamsSchema = z
  .object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    requires_network: z.boolean().optional(),
    sandbox_permissions: z
      .enum(['use_default', 'require_escalated'])
      .optional(),
    justification: z.string().min(1).max(500).optional(),
    prefix_rule: z.array(z.string().min(1).max(128)).max(16).optional(),
  })
  .refine(
    (value) =>
      value.sandbox_permissions !== 'require_escalated' ||
      (value.justification !== undefined &&
        value.justification.trim().length > 0),
    {
      message: 'require_escalated requires a non-empty justification',
      path: ['justification'],
    },
  )
export type ShellExecuteParams = z.infer<typeof ShellExecuteParamsSchema>
