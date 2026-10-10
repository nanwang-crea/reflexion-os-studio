import { z } from 'zod'
import { IsoDateTimeSchema } from './shared.js'
import { UsageSchema } from './chat/runs.js'
import { PermissionPresetSchema } from './tools/permissions.js'
import { ResourceLinkSchema } from '../resource-links.js'
import { ChangedFileSchema } from '../tool-output.js'

export const DelegationStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>

/** Agent 自身能力上限；Runtime 仍会与父 Run/全局安全边界取交集。 */
export const AgentPolicySchema = z.object({
  version: z.literal(1),
  permissionCeiling: PermissionPresetSchema,
  allowedTools: z.array(z.string().min(1)),
  canDelegate: z.boolean(),
})
export type AgentPolicy = z.infer<typeof AgentPolicySchema>

/** Stable definition of an agent available for delegation. */
export const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string().min(1),
  policy: AgentPolicySchema,
  enabled: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

export const AgentTemplateSourceSchema = z.enum(['builtin', 'user', 'project'])
export type AgentTemplateSource = z.infer<typeof AgentTemplateSourceSchema>

/** Optional reusable guidance. It may only narrow a child's inherited boundary. */
export const AgentTemplateSchema = AgentDefinitionSchema.extend({
  source: AgentTemplateSourceSchema,
  builtin: z.boolean(),
})
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>

export const AgentSpawnSpecSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  role: z.string().min(1).max(120).optional(),
  instructions: z.string().min(1).max(20_000).optional(),
  templateId: z.string().min(1).optional(),
})
export type AgentSpawnSpec = z.infer<typeof AgentSpawnSpecSchema>

/** Immutable snapshot created for each delegation. */
export const AgentInstanceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string(),
  templateId: z.string().min(1).nullable(),
  instructions: z.string().min(1),
  permissionPreset: PermissionPresetSchema,
  permissionDomainId: z.string().min(1),
  allowedTools: z.array(z.string().min(1)),
  canDelegate: z.boolean(),
  createdAt: IsoDateTimeSchema,
})
export type AgentInstance = z.infer<typeof AgentInstanceSchema>

export const MutationReceiptSchema = z.object({
  id: z.string().min(1),
  rootRunId: z.string().min(1),
  runId: z.string().min(1),
  delegationId: z.string().min(1).nullable(),
  agentInstanceId: z.string().min(1).nullable(),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  changedFiles: z.array(ChangedFileSchema),
  createdAt: IsoDateTimeSchema,
})
export type MutationReceipt = z.infer<typeof MutationReceiptSchema>

const DelegationExecutionV1Schema = z.object({
  version: z.literal(1),
  depth: z.number().int().positive(),
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1),
  permissionPreset: PermissionPresetSchema,
  allowedTools: z.array(z.string().min(1)),
  timeoutSec: z.number().int().positive().nullable(),
  tokenBudget: z.number().int().positive().nullable(),
})

/** 委派创建时冻结的实际执行边界及根级治理上限。 */
export const DelegationExecutionV2Schema = z.object({
  version: z.literal(2),
  rootRunId: z.string().min(1),
  depth: z.number().int().positive().max(4),
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1),
  permissionPreset: PermissionPresetSchema,
  allowedTools: z.array(z.string().min(1)),
  agentPolicy: AgentPolicySchema,
  timeoutSec: z.number().int().positive().nullable(),
  tokenBudget: z.number().int().positive().nullable(),
  treeRunBudget: z.number().int().positive().nullable(),
  treeParallelBudget: z.number().int().positive().nullable(),
})

export const DelegationExecutionSchema = z.union([
  DelegationExecutionV1Schema,
  DelegationExecutionV2Schema,
  z.object({
    version: z.literal(3),
    rootRunId: z.string().min(1),
    permissionDomainId: z.string().min(1),
    depth: z.number().int().positive().max(4),
    providerId: z.string().min(1).nullable(),
    model: z.string().min(1),
    permissionPreset: PermissionPresetSchema,
    allowedTools: z.array(z.string().min(1)),
    instance: AgentInstanceSchema,
    timeoutSec: z.number().int().positive().nullable(),
    tokenBudget: z.number().int().positive().nullable(),
    treeRunBudget: z.number().int().positive().nullable(),
    treeParallelBudget: z.number().int().positive().nullable(),
  }),
])
export type DelegationExecution = z.infer<typeof DelegationExecutionSchema>

/** Runtime 从 child Run canonical 数据派生；模型只提供 summary。 */
export const DelegationResultSchema = z.object({
  version: z.literal(1),
  summary: z.string(),
  resourceLinks: z.array(ResourceLinkSchema),
  changedFiles: z.array(ChangedFileSchema),
  usage: UsageSchema.nullable(),
  toolCallCount: z.number().int().nonnegative(),
})
export type DelegationResult = z.infer<typeof DelegationResultSchema>

/** 子 Agent 委派及其可审计执行快照；旧记录的新增字段允许为 null。 */
export const DelegationSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentRunId: z.string().min(1),
  rootRunId: z.string().min(1).nullable(),
  parentAgentId: z.string().min(1).nullable(),
  agentId: z.string().min(1),
  agentInstance: AgentInstanceSchema.nullable(),
  task: z.string().min(1),
  status: DelegationStatusSchema,
  childSessionId: z.string().min(1).nullable(),
  childRunId: z.string().min(1).nullable(),
  execution: DelegationExecutionSchema.nullable(),
  result: z.string().nullable(),
  structuredResult: DelegationResultSchema.nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
})
export type Delegation = z.infer<typeof DelegationSchema>

/** Agent 运行时全局设置：null 表示使用内置默认值。 */
export const AgentSettingsSchema = z.object({
  // 单次 Run 的最大模型调用轮次；超限如实失败。
  maxTurns: z.number().int().positive().max(256).nullable(),
  // 工具失败累计次数达到该值注入反思消息；0=禁用反思。
  reflectionThreshold: z.number().int().min(0).max(10).nullable(),
  // Provider 请求建立阶段失败(可恢复 400/429/5xx/网络)自动重试次数。
  requestRetries: z.number().int().min(0).max(15).nullable(),
  // Provider 请求超时(秒)。
  requestTimeoutSec: z.number().int().min(10).max(600).nullable(),
  // —— W4 Run 预算：null 表示使用内置默认，而不是无限制 ——
  // Run 总时长上限（秒）。
  maxRunTimeoutSec: z.number().int().min(10).max(7200).nullable(),
  // Run 累计 token 总量上限（prompt+completion，来自 Provider usage）。
  maxRunTotalTokens: z.number().int().min(1000).max(1_000_000_000).nullable(),
  // Run 全程工具调用次数上限。
  maxToolCalls: z.number().int().min(1).max(4096).nullable(),
  // length 续写最大连续轮次。
  maxContinuationTurns: z.number().int().min(0).max(8).nullable(),
  // 子 Agent 最大委派深度。
  maxDepth: z.number().int().min(1).max(4).nullable(),
  // 单个顶层 Run 的整棵委派树最多创建的子 Agent 数量。
  maxChildRuns: z.number().int().min(1).max(32).nullable(),
  // 单个顶层 Run 的整棵委派树最大并行数。
  maxParallelChildren: z.number().int().min(1).max(8).nullable(),
  // 单个子 Agent 最大运行时间(秒)。
  maxChildTimeoutSec: z.number().int().min(10).max(3600).nullable(),
  // 单次子 Agent 最大输出 token 数。
  maxChildTotalTokens: z.number().int().min(1000).max(1000000).nullable(),
  // Phase 3A 子 Run 总开关；默认启用，false 是运行时逃生开关。
  enableChildRuns: z.boolean().default(true),
})
export type AgentSettings = z.infer<typeof AgentSettingsSchema>

/**
 * Context Checkpoint 结构化摘要（Context Engine V2）：
 * 每项限制长度与数量，不允许承载 API Key/cookie/token 等凭据或大段工具输出。
 * canonical 历史仍是事实源；Checkpoint 是可失效、可重建的派生缓存。
 */
export const ContextCheckpointSummarySchema = z.object({
  goal: z.string().max(500).nullable(),
  constraints: z.array(z.string().max(300)).max(8),
  decisions: z.array(z.string().max(300)).max(12),
  completed: z.array(z.string().max(300)).max(12),
  pending: z.array(z.string().max(300)).max(12),
  toolFacts: z.array(z.string().max(300)).max(12),
  knownErrors: z.array(z.string().max(300)).max(8),
})
export type ContextCheckpointSummary = z.infer<
  typeof ContextCheckpointSummarySchema
>
