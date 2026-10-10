import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'
import { JsonValueSchema } from '../../json-value.js'

export const RunStatusSchema = z.enum([
  'created',
  'running',
  // Run 暂停等待用户审批工具调用；崩溃重启后恢复为 interrupted，不自动放行。
  'awaiting_approval',
  // Run 暂停等待结构化用户回答；与权限审批语义分离。
  'awaiting_user_input',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

/** 一次模型调用的 token 用量（Run/事件共用；历史 Run 可为 null）。 */
export const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  /** Provider 回传的命中前缀缓存的 prompt token 数；缺省表示端点未报告缓存信息。 */
  cachedPromptTokens: z.number().int().nonnegative().optional(),
})
export type Usage = z.infer<typeof UsageSchema>

export const RunSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  planId: z.string().min(1).nullable(),
  planStepId: z.string().min(1).nullable(),
  status: RunStatusSchema,
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  errorCode: z.string().nullable(),
  retryOfRunId: z.string().min(1).nullable(),
  supersededByRunId: z.string().min(1).nullable(),
  // 执行该 Run 的 Agent；多 Agent 委派链路字段，Primary Agent 为 null。
  agentId: z.string().min(1).nullable(),
  parentRunId: z.string().min(1).nullable(),
  delegationId: z.string().min(1).nullable(),
  // 本次 Run 激活的 Skill（斜杠命令或显式传入）；未激活为 null。
  skillId: z.string().min(1).nullable(),
  agentTemplateId: z.string().min(1).nullable(),
  // 全轮合计 token 用量（各模型轮累加）；进行中/旧数据为 null。
  usage: UsageSchema.nullable(),
})
export type Run = z.infer<typeof RunSchema>

export const TurnPhaseSchema = z.enum([
  'processing_input',
  'awaiting_model_response',
  'streaming',
  'scheduling_tools',
  'awaiting_permission',
  'executing_tools',
  'aggregating_results',
  'awaiting_user_input',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
export type TurnPhase = z.infer<typeof TurnPhaseSchema>

/**
 * A persisted execution checkpoint for one model/tool cycle within a Run.
 * JSON payloads intentionally remain versioned opaque snapshots: the runtime
 * may inspect them for recovery, but never treats them as executable grants.
 */
export const TurnExecutionSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  phase: TurnPhaseSchema,
  attempt: z.number().int().positive(),
  modelRequest: JsonValueSchema.nullable(),
  assistantMessageId: z.string().min(1).nullable(),
  toolBatch: JsonValueSchema.nullable(),
  pendingInteractionId: z.string().min(1).nullable(),
  pendingApprovalId: z.string().min(1).nullable(),
  continuationReason: z.string().nullable(),
  runtimeState: JsonValueSchema.nullable().default(null),
  checkpointVersion: z.number().int().positive(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
})
export type TurnExecution = z.infer<typeof TurnExecutionSchema>

export const RunEventTypeSchema = z.enum(['retrying', 'failed'])
export type RunEventType = z.infer<typeof RunEventTypeSchema>

export const RunEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  type: RunEventTypeSchema,
  attempt: z.number().int().positive().nullable(),
  maxRetries: z.number().int().nonnegative().nullable(),
  reason: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
})
export type RunEvent = z.infer<typeof RunEventSchema>
