import { z } from 'zod'

export const IsoDateTimeSchema = z.iso.datetime()
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
})
export type Project = z.infer<typeof ProjectSchema>

export const SessionStatusSchema = z.enum(['active', 'archived'])
export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const SessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
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
  model: z.string().min(1),
  secretRef: z.string().min(1),
  enabled: z.boolean(),
  updatedAt: IsoDateTimeSchema,
})
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>
