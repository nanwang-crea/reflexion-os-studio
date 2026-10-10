import { z } from 'zod'
import { MAX_MESSAGE_IMAGES } from '../images.js'
import { PermissionPresetSchema } from '../entities.js'
export const RequestIdSchema = z.string().min(1)
export type RequestId = z.infer<typeof RequestIdSchema>

export const PluginInstallParamsSchema = z.discriminatedUnion('source', [
  z.object({
    requestId: RequestIdSchema,
    source: z.literal('dir'),
    projectId: z.string().min(1),
    path: z.string().min(1),
    installScope: z.enum(['global', 'project']).optional(),
    installProjectId: z.string().min(1).optional(),
  }),
  z.object({
    requestId: RequestIdSchema,
    source: z.literal('local'),
    path: z.string().min(1),
    installScope: z.enum(['global', 'project']).optional(),
    installProjectId: z.string().min(1).optional(),
  }),
  z.object({
    requestId: RequestIdSchema,
    source: z.literal('git'),
    url: z.string().url(),
    installScope: z.enum(['global', 'project']).optional(),
    installProjectId: z.string().min(1).optional(),
  }),
])

export const MessageSendParamsSchema = z.object({
  requestId: RequestIdSchema,
  sessionId: z.string().min(1),
  content: z.string().min(1),
  imageAssetIds: z.array(z.string().min(1)).max(MAX_MESSAGE_IMAGES).optional(),
  // 不传则使用启用的 Provider 及其第一个模型。
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  // 本次回复的模型采样参数；缺省用 Provider 配置的默认值。
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  // 本次发送的权限预设快照；缺省 workspace-read（保守回落，不静默扩大写权限）。
  permissionPreset: PermissionPresetSchema.optional(),
  // @deprecated 兼容一个协议版本：legacy `permissionMode`/`trusted` 双轨。
  // 新前端不再发送；Runtime 按下表映射（workspace/read-only→workspace-read、
  // trusted=true→workspace-full），冲突时新字段优先。下一协议版本删除。
  permissionMode: z.enum(['workspace', 'read-only']).optional(),
  trusted: z.boolean().optional(),
  // 显式激活的 Skill；内容以 /<skillId> 开头时也可隐式激活（显式优先）。
  skillId: z.string().min(1).optional(),
  // 用户显式指定本次根 Run 的默认子 Agent 模板；优先于模型在 task 中的选择。
  agentTemplateId: z.string().min(1).optional(),
})
export type ChatCommand = z.infer<typeof MessageSendParamsSchema>

/** 消息编辑重发命令参数。 */
export const MessageEditResendParamsSchema = z.object({
  requestId: RequestIdSchema,
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  content: z.string().min(1),
  // 可选覆盖 Provider/模型/参数（与 message.send 同义）。
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  permissionPreset: PermissionPresetSchema.optional(),
  skillId: z.string().min(1).optional(),
  agentTemplateId: z.string().min(1).optional(),
})
export type MessageEditResendParams = z.infer<
  typeof MessageEditResendParamsSchema
>

/** 消息编辑重发结果。 */
export const MessageEditResendResultSchema = z.object({
  queued: z.boolean(),
  messageId: z.string().min(1).nullable(),
  runId: z.string().min(1).nullable(),
  queueId: z.string().min(1).nullable(),
  position: z.number().int().nonnegative().nullable(),
})
export type MessageEditResendResult = z.infer<
  typeof MessageEditResendResultSchema
>

/**
 * 审批裁决：只接受 toolCallId + choiceId。choiceId 必须属于当前 pending
 * approval，Runtime 据此查服务端保存的真实 effect；旧的 decision + scope
 * 不再作为权威输入。
 */
export const ApprovalResolveParamsSchema = z.object({
  requestId: RequestIdSchema,
  toolCallId: z.string().min(1),
  choiceId: z.string().min(1),
})
export type ApprovalResolveCommand = z.infer<typeof ApprovalResolveParamsSchema>

export const RunCancelParamsSchema = z.object({
  requestId: RequestIdSchema,
  runId: z.string().min(1),
})
export type CancelCommand = z.infer<typeof RunCancelParamsSchema>

export const RunRetryParamsSchema = z.object({
  requestId: RequestIdSchema,
  runId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
})
export type RunRetryParams = z.infer<typeof RunRetryParamsSchema>
