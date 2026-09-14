import { z } from 'zod'
import {
  JsonValueSchema,
  ApprovalOperationSchema,
  MessageSchema,
  RunSchema,
  UsageSchema,
  ContentPartSchema,
  WorkspaceIndexSnapshotSchema,
  QueueEntrySchema,
  McpServerSchema,
  PlanSchema,
  PlanStepSchema,
  DelegationSchema,
  TerminalStatusSchema,
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

// 事件作用域：显式声明每条事件归属的资源流，取代“借用 runId”的旧信封。
// 判别联合以 type 单键判别；scope 字面量与资源字段在每个变体内成对声明，
// schema 保证 type/scope/资源字段三者一致。
export const EventScopeSchema = z.enum([
  'runtime',
  'run',
  'session',
  'project',
  'mcp',
  'terminal',
])
export type EventScope = z.infer<typeof EventScopeSchema>

export const RuntimeEventEnvelopeSchema = z.object({
  protocolVersion: z.string(),
  eventId: z.string().min(1),
  scope: EventScopeSchema,
  seq: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
})
export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelopeSchema>

// run 作用域公共信封：run 通道事件全部 extend 它（runId 真实归属）。
const RunEnvelopeSchema = RuntimeEventEnvelopeSchema.extend({
  scope: z.literal('run'),
  runId: z.string().min(1),
})

// terminal 作用域公共信封（事件在 W2 接线，契约在本阶段冻结）。
const TerminalEnvelopeSchema = RuntimeEventEnvelopeSchema.extend({
  scope: z.literal('terminal'),
  projectId: z.string().min(1),
  terminalId: z.string().min(1),
})

export const RuntimeEventSchema = z.discriminatedUnion('type', [
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('runtime.status'),
    scope: z.literal('runtime'),
    status: RuntimeStatusSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.created'),
    message: MessageSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.delta'),
    messageId: z.string().min(1),
    chunkSeq: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.reset'),
    messageId: z.string().min(1),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.reasoning_delta'),
    messageId: z.string().min(1),
    chunkSeq: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('message.completed'),
    messageId: z.string().min(1),
    content: z.string(),
    finishReason: FinishReasonSchema,
    usage: UsageSchema.optional(),
    parts: z.array(ContentPartSchema).optional(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.started'),
    run: RunSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.completed'),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.retrying'),
    attempt: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    reason: z.string(),
    // 本次重试前的退避等待时长（毫秒）；UI 用它展示倒计时。
    // 可选：旧版 runtime 事件与持久化的 run_events 历史记录不含该字段。
    waitMs: z.number().int().nonnegative().optional(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.failed'),
    error: RuntimeErrorSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('run.cancelled'),
  }),
  // 计划事件：run 作用域，载荷与旧契约一致。
  RunEnvelopeSchema.extend({
    type: z.literal('plan.created'),
    plan: PlanSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('plan.step.updated'),
    planId: z.string().min(1),
    step: PlanStepSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('plan.updated'),
    plan: PlanSchema,
  }),
  // 工具调用与审批事件。
  RunEnvelopeSchema.extend({
    type: z.literal('tool.requested'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    args: JsonValueSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('tool.completed'),
    toolCallId: z.string().min(1),
    status: z.enum(['completed', 'failed', 'cancelled']),
    errorCode: z.string().nullable(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('approval.required'),
    toolCallId: z.string().min(1),
    operation: ApprovalOperationSchema,
    summary: z.string(),
    // 审批所属会话：侧栏会话行据此显示待审批标记。可选：旧版 runtime
    // 事件与持久化的 run_events 历史记录不含该字段（对齐 waitMs 先例）。
    sessionId: z.string().min(1).optional(),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('approval.resolved'),
    toolCallId: z.string().min(1),
    decision: z.enum(['approved', 'denied']),
    // 原 payload 字段名 scope（once/session）改名 grantScope：
    // 避免与信封 scope 在 .extend() 合并时静默互相覆盖。
    grantScope: z.enum(['once', 'session']),
  }),
  // Phase 1B Workspace 索引事件：project 作用域，projectId 为真实身份。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('workspace.index.progress'),
    scope: z.literal('project'),
    projectId: z.string().min(1),
    version: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    dirs: z.number().int().nonnegative(),
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('workspace.index.completed'),
    scope: z.literal('project'),
    projectId: z.string().min(1),
    snapshot: WorkspaceIndexSnapshotSchema,
  }),
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('workspace.index.failed'),
    scope: z.literal('project'),
    projectId: z.string().min(1),
    error: z.string(),
  }),
  // 会话发送队列快照：session 作用域，sessionId 为真实身份。
  // paused：队列是否处于"用户停止后暂停待确认"状态；可选：旧版 runtime 不含该字段。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('queue.changed'),
    scope: z.literal('session'),
    sessionId: z.string().min(1),
    paused: z.boolean().optional(),
    items: z.array(QueueEntrySchema),
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('delegation.created'),
    delegation: DelegationSchema,
  }),
  RunEnvelopeSchema.extend({
    type: z.literal('delegation.updated'),
    delegation: DelegationSchema,
  }),
  // MCP server 状态变化(disabled/ready/failed)：mcp 作用域，serverId 为真实身份。
  RuntimeEventEnvelopeSchema.extend({
    type: z.literal('mcp.changed'),
    scope: z.literal('mcp'),
    serverId: z.string().min(1),
    server: McpServerSchema,
  }),
  // 集成终端事件（W2 接线，本阶段冻结契约）。output 载荷为 base64 字节帧。
  TerminalEnvelopeSchema.extend({
    type: z.literal('terminal.output'),
    outputSeq: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    consumerId: z.string().min(1),
    data: z.string().min(1),
  }),
  TerminalEnvelopeSchema.extend({
    type: z.literal('terminal.state'),
    status: TerminalStatusSchema,
    // exitCode 三态：缺省=尚未退出/未知；null=被信号终止或不可得；数字=退出码。
    exitCode: z.number().int().nullable().optional(),
    errorMessage: z.string().optional(),
  }),
])
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>

export type RuntimeEventName = RuntimeEvent['type']
