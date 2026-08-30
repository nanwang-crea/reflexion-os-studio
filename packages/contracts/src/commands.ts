import { z } from 'zod'
import {
  MessageSchema,
  ProviderProfileSchema,
  ProjectSchema,
  RunSchema,
  SessionSchema,
} from './entities.js'
import { RuntimeStatusSchema } from './handshake.js'

export const RequestIdSchema = z.string().min(1)
export type RequestId = z.infer<typeof RequestIdSchema>

export const MessageSendParamsSchema = z.object({
  requestId: RequestIdSchema,
  sessionId: z.string().min(1),
  content: z.string().min(1),
  // 不传则使用启用的 Provider 及其第一个模型。
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
})
export type ChatCommand = z.infer<typeof MessageSendParamsSchema>

export const RunCancelParamsSchema = z.object({
  requestId: RequestIdSchema,
  runId: z.string().min(1),
})
export type CancelCommand = z.infer<typeof RunCancelParamsSchema>

export const RunRetryParamsSchema = z.object({
  requestId: RequestIdSchema,
  runId: z.string().min(1),
})

export const CommandSchemaRegistry = {
  'runtime.get_status': {
    params: z.object({ requestId: RequestIdSchema }),
    result: RuntimeStatusSchema,
  },
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
    }),
  },
  'message.send': {
    params: MessageSendParamsSchema,
    result: z.object({
      messageId: z.string().min(1),
      runId: z.string().min(1),
    }),
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
  'provider.list': {
    params: z.object({ requestId: RequestIdSchema }),
    result: z.object({ profiles: z.array(ProviderProfileSchema) }),
  },
  'provider.configure': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      baseUrl: z.url(),
      models: z.array(z.string().min(1)).min(1),
      // 只写字段：明文 Key 仅在请求中出现一次，runtime 落入本地 secret 存储，
      // profile 只返回 secretRef。任何响应/事件/日志不得包含 secret。
      secret: z.string().min(1).optional(),
      // 编辑且不换 Key 时必须回传既有 secretRef。
      secretRef: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
    }),
    result: z.object({ profile: ProviderProfileSchema }),
  },
  'provider.delete': {
    params: z.object({
      requestId: RequestIdSchema,
      id: z.string().min(1),
    }),
    result: z.object({ removed: z.boolean() }),
  },
  'provider.test': {
    params: z.object({
      requestId: RequestIdSchema,
      baseUrl: z.url(),
      model: z.string().min(1),
      // 测试请求的明文 Key 只在内存中使用一次，不落盘。
      secret: z.string().min(1).optional(),
      secretRef: z.string().min(1).optional(),
    }),
    result: z.object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
      model: z.string().min(1),
      error: z.string().nullable(),
    }),
  },
} satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type CommandName = keyof typeof CommandSchemaRegistry

export type CommandSchemaEntry = {
  params: z.ZodType
  result: z.ZodType
}

export function lookupCommandSchema(
  method: string,
): CommandSchemaEntry | undefined {
  const entry = (CommandSchemaRegistry as Record<string, CommandSchemaEntry>)[
    method
  ]
  return entry
}
