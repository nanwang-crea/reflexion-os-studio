import { z } from 'zod'
import {
  JsonValueSchema,
  MemorySchema,
  MessageSchema,
  RunSchema,
  SessionSchema,
  ToolOperationSchema,
  UsageSchema,
  WorkspaceIndexSnapshotSchema,
  QueueEntrySchema,
  McpServerSchema,
  PlanSchema,
  PlanStepSchema,
} from './entities.js'
import { RuntimeErrorSchema } from './errors.js'
import { RuntimeStatusSchema } from './handshake.js'

export type { Usage } from './entities.js'

export const FinishReasonSchema = z.enum([
  'stop',
  'length',
  'content_filter',
  // 模型请求工具调用；Agent 工具循环据此继续本轮 Run。
  'tool_calls',
  'cancelled',
])
export type FinishReason = z.infer<typeof FinishReasonSchema>

export const RuntimeEventEnvelopeSchema = z.object({
  protocolVersion: z.string(),
  eventId: z.string().min(1),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
})
export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>

export const RuntimeEventSchema = z.discriminatedUnion('type', [
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('runtime.status'),
    status: RuntimeStatusSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('session.created'),
    session: SessionSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('message.created'),
    message: MessageSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('message.delta'),
    messageId: z.string().min(1),
    chunkSeq: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('message.reasoning_delta'),
    messageId: z.string().min(1),
    chunkSeq: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('message.completed'),
    messageId: z.string().min(1),
    content: z.string(),
    finishReason: FinishReasonSchema,
    usage: UsageSchema.optional(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('run.started'),
    run: RunSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('run.completed'),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('run.retrying'),
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    reason: z.string(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('run.failed'),
    error: RuntimeErrorSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('run.cancelled'),
  }),
  // 工具调用与审批事件（Agent Core 阶段开始发出；A0 先固定契约）。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('plan.created'),
    plan: PlanSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('plan.step.updated'),
    planId: z.string().min(1),
    step: PlanStepSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('plan.updated'),
    plan: PlanSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('tool.requested'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    args: JsonValueSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('tool.completed'),
    toolCallId: z.string().min(1),
    status: z.enum(['completed', 'failed', 'cancelled']),
    errorCode: z.string().nullable(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('approval.required'),
    toolCallId: z.string().min(1),
    operation: ToolOperationSchema,
    summary: z.string(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('approval.resolved'),
    toolCallId: z.string().min(1),
    decision: z.enum(['approved', 'denied']),
    scope: z.enum(['once', 'session']),
  }),
  // A2 Memory：Run 结束后异步提取落库的记忆；UI 据此做非打断式提示。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('memory.written'),
    memories: z.array(MemorySchema),
  }),
  // Phase 1B Workspace 索引事件：不属于任何 Run，envelope.runId 复用 projectId。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('workspace.index.progress'),
    projectId: z.string().min(1),
    version: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    dirs: z.number().int().nonnegative(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('workspace.index.completed'),
    projectId: z.string().min(1),
    snapshot: WorkspaceIndexSnapshotSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('workspace.index.failed'),
    projectId: z.string().min(1),
    error: z.string(),
  }),
  // 会话发送队列快照：入队/修改/删除/立即发送/出队时广播(envelope.runId=sessionId)。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('queue.changed'),
    sessionId: z.string().min(1),
    items: z.array(QueueEntrySchema),
  }),
  // MCP server 状态变化(ready/failed/removed),envelope.runId=serverId。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('mcp.changed'),
    serverId: z.string().min(1),
    server: McpServerSchema,
  }),
])
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>

export type RuntimeEventName = RuntimeEvent['type']
