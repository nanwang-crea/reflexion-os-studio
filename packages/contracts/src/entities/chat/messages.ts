import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'
import { PermissionPresetSchema } from '../tools/permissions.js'
import { ResourceLinkSchema } from '../../resource-links.js'

/** 消息内容块：canonical 表示；媒体以引用进入，不内联原始数据。 */
export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})
export type TextPart = z.infer<typeof TextPartSchema>

export const ImagePartSchema = z.object({
  type: z.literal('image'),
  // 指向 Asset Store；图片字节只经上传/读取命令传递，消息与数据库存引用。
  assetId: z.string().min(1),
  mimeType: z.string().min(1),
})
export type ImagePart = z.infer<typeof ImagePartSchema>

export const ResourceLinkPartSchema = z.object({
  type: z.literal('resource_link'),
  label: z.string().min(1),
  link: ResourceLinkSchema,
})
export type ResourceLinkPart = z.infer<typeof ResourceLinkPartSchema>

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ImagePartSchema,
  ResourceLinkPartSchema,
])
export type ContentPart = z.infer<typeof ContentPartSchema>

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

export const MessageStatusSchema = z.enum([
  'pending',
  'streaming',
  'completed',
  'interrupted',
  'failed',
  'superseded',
])
export type MessageStatus = z.infer<typeof MessageStatusSchema>

export const MessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  role: MessageRoleSchema,
  content: z.string(),
  // canonical 内容块；content 是其中 text 块拼接的纯文本投影，仅供 UI 显示。
  parts: z.array(ContentPartSchema),
  // 推理模型的思考内容；非思考模型或旧数据为空字符串。
  reasoning: z.string(),
  status: MessageStatusSchema,
  createdAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
})
export type Message = z.infer<typeof MessageSchema>

/** 会话发送队列项：等待上一条回复结束时按 FIFO 自动发送。 */
export const QueueEntrySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  content: z.string().min(1),
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  // 发送时捕获的权限预设快照；UI badge 与实际执行档位一致。
  permissionPreset: PermissionPresetSchema.nullable(),
  skillId: z.string().min(1).nullable(),
  agentTemplateId: z.string().min(1).nullable(),
  imageAssetIds: z.array(z.string().min(1)).optional(),
  /** 0 起位置；出队发送时该项即消失。 */
  position: z.number().int().nonnegative(),
})
export type QueueEntry = z.infer<typeof QueueEntrySchema>
