import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'
import { JsonValueSchema } from '../../json-value.js'
import { ToolOutputSchema } from '../../tool-output.js'

export const ToolCallStatusSchema = z.enum([
  'pending',
  'awaiting_approval',
  'awaiting_user_input',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>

/** Agent 侧工具声明的 canonical 形式；provider 适配层投影为方言格式。 */
export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  // JSON Schema 形式的参数声明。
  parameters: JsonValueSchema,
})
export type ToolSpec = z.infer<typeof ToolSpecSchema>

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  // 发出该调用的 assistant 消息；无关联消息时为 null。
  messageId: z.string().min(1).nullable(),
  toolName: z.string().min(1),
  args: JsonValueSchema,
  /** @deprecated 新代码读取 output；保留 data 投影兼容现有 UI 与调用方。 */
  result: JsonValueSchema.nullable(),
  // Older Runtime snapshots do not include the canonical envelope.
  output: ToolOutputSchema.nullable().default(null),
  status: ToolCallStatusSchema,
  errorCode: z.string().nullable(),
  // 关联的短期审批授权引用；不进事件 payload，不落审计日志。
  approvalGrantId: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
})
export type ToolCall = z.infer<typeof ToolCallSchema>
