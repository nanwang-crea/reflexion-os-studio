import { z } from 'zod'
import {
  MessageSchema,
  RunEventSchema,
  ProjectSchema,
  RunSchema,
  SessionSchema,
  ToolCallSchema,
  QueueEntrySchema,
  PlanSchema,
  ExecutionModeSchema,
} from '../entities.js'
import {
  RequestIdSchema,
  MessageSendParamsSchema,
  MessageEditResendParamsSchema,
  MessageEditResendResultSchema,
  RunCancelParamsSchema,
  RunRetryParamsSchema,
} from './params.js'

export const chatCommands = {
  'project.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ projects: z.array(ProjectSchema) }),
  },
  'project.create': {
    params: z.object({
      requestId: RequestIdSchema,
      // 项目必须绑定一个本地文件夹（由宿主文件夹选择器提供）。
      folderPath: z.string().min(1),
      name: z.string().min(1).optional(),
    }),
    result: z.object({ project: ProjectSchema }),
  },
  'session.list': {
    params: z.object({
      requestId: RequestIdSchema,
      // 省略 → 全部会话；null → 独立会话；具体 id → 该项目下的会话。
      projectId: z.union([z.string().min(1), z.null()]).optional(),
    }),
    result: z.object({ sessions: z.array(SessionSchema) }),
  },
  'session.create': {
    params: z.object({
      requestId: RequestIdSchema,
      // null / 省略 → 独立会话（不关联项目）。
      projectId: z.union([z.string().min(1), z.null()]).optional(),
      title: z.string().min(1).optional(),
      // Deprecated legacy input: accepted by the wire schema for old clients,
      // then rejected by Runtime so new sessions cannot claim a branch switch.
      gitBranch: z.string().min(1).nullable().optional(),
    }),
    result: z.object({ session: SessionSchema }),
  },
  'session.rename': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      title: z.string().min(1),
    }),
    result: z.object({ session: SessionSchema }),
  },
  'session.execution_mode.set': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      mode: ExecutionModeSchema,
    }),
    result: z.object({ session: SessionSchema }),
  },
  'session.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'project.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      projectId: z.string().min(1),
    }),
    // 项目删除级联其下会话（会话再级联消息与 Run）。
    result: z.object({ removed: z.boolean() }),
  },
  'session.get': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({
      session: SessionSchema.nullable(),
      messages: z.array(MessageSchema),
      runs: z.array(RunSchema),
      // 会话内全部工具调用（跨 Run 汇总），供 UI 呈现工具轨迹。
      toolCalls: z.array(ToolCallSchema),
      // 会话内全部计划（跨 Run 汇总），供 UI 呈现计划轨迹。
      plans: z.array(PlanSchema),
      // 运行事件（重试/失败）。旧版 Runtime snapshot 缺该字段：默认空数组，
      // 避免响应校验失败导致整个会话数据被丢弃（前端消息消失）。
      runEvents: z.array(RunEventSchema).default([]),
    }),
  },
  'message.send': {
    params: MessageSendParamsSchema,
    // 会话空闲时立即发送(queued=false,带 messageId/runId);
    // 会话忙碌时自动入队(queued=true,带 queueId/position)。
    result: z.object({
      queued: z.boolean(),
      messageId: z.string().min(1).nullable(),
      runId: z.string().min(1).nullable(),
      queueId: z.string().min(1).nullable(),
      position: z.number().int().nonnegative().nullable(),
    }),
  },
  'message.edit_resend': {
    params: MessageEditResendParamsSchema,
    result: MessageEditResendResultSchema,
  },
  'queue.list': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({
      items: z.array(QueueEntrySchema),
      // 队列是否处于暂停待确认态；可选：旧版 runtime 缺该字段。
      paused: z.boolean().optional(),
    }),
  },
  'queue.update': {
    // 修改排队中消息的内容(斜杠技能随新内容重新解析)。
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      queueId: z.string().min(1),
      content: z.string().min(1),
    }),
    result: z.object({ item: QueueEntrySchema.nullable() }),
  },
  'queue.remove': {
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      queueId: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'queue.send_now': {
    // 立即发送:移该项到队首,当前空闲则立刻开始执行。
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
      queueId: z.string().min(1),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  'queue.resume': {
    // 解除用户停止 Run 后的队列暂停；若会话空闲且队列非空则立即出队发送。
    params: z.object({
      requestId: RequestIdSchema,
      sessionId: z.string().min(1),
    }),
    result: z.object({ resumed: z.boolean() }),
  },
  'run.cancel': {
    params: RunCancelParamsSchema,
    result: z.object({ accepted: z.boolean() }),
  },
  'run.retry': {
    params: RunRetryParamsSchema,
    result: z.object({
      messageId: z.string().min(1),
      runId: z.string().min(1),
      retryOfRunId: z.string().min(1),
    }),
  },
}
