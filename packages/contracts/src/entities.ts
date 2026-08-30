import { z } from 'zod'

export const IsoDateTimeSchema = z.iso.datetime()
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // 项目对应的本地文件夹绝对路径；历史数据允许为空字符串。
  folderPath: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type Project = z.infer<typeof ProjectSchema>

export const SessionStatusSchema = z.enum(['active', 'archived'])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const SessionSchema = z.object({
  id: z.string().min(1),
  // null 表示不关联任何项目的独立会话。
  projectId: z.string().min(1).nullable(),
  title: z.string().min(1),
  status: SessionStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type Session = z.infer<typeof SessionSchema>

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

export const MessageStatusSchema = z.enum([
  'pending',
  'streaming',
  'completed',
  'interrupted',
  'failed',
])
export type MessageStatus = z.infer<typeof MessageStatusSchema>

export const MessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  role: MessageRoleSchema,
  content: z.string(),
  // 推理模型的思考内容；非思考模型或旧数据为空字符串。
  reasoning: z.string(),
  status: MessageStatusSchema,
  createdAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
})
export type Message = z.infer<typeof MessageSchema>

export const RunStatusSchema = z.enum([
  'created',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

export const RunSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  status: RunStatusSchema,
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  errorCode: z.string().nullable(),
  retryOfRunId: z.string().min(1).nullable(),
})
export type Run = z.infer<typeof RunSchema>

export const ProviderProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.url(),
  // 该供应商下可选的模型列表；对话时可指定其中一个。
  models: z.array(z.string().min(1)).min(1),
  secretRef: z.string().min(1),
  enabled: z.boolean(),
  updatedAt: IsoDateTimeSchema,
})
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>
