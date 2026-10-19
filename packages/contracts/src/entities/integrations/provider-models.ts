import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'
import { ReasoningEffortSchema, ReasoningOptionsSchema } from './reasoning.js'

export const ModelReasoningCapabilitiesSchema = z.object({
  thinking: z.boolean().nullable(),
  effort: z.boolean().nullable(),
  options: ReasoningOptionsSchema.nullable(),
  source: z.enum(['provider', 'catalog', 'unknown', 'manual']),
  checkedAt: IsoDateTimeSchema.nullable(),
})
export type ModelReasoningCapabilities = z.infer<
  typeof ModelReasoningCapabilitiesSchema
>

/** Provider 下单个模型的能力与运行参数覆盖。null 表示继承 Provider 默认。 */
export const ProviderModelSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).nullable(),
  maxTokens: z.number().int().positive().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  contextBudget: z.number().int().positive().nullable(),
  reasoningEffort: ReasoningEffortSchema.nullable(),
  reasoningOptions: ReasoningOptionsSchema,
  reasoningEffortSupported: z.boolean(),
  reasoningMode: z.enum(['auto', 'manual']).optional(),
  thinkingSupported: z.boolean().nullable().optional(),
  reasoningCapabilities: ModelReasoningCapabilitiesSchema.optional(),
  updatedAt: IsoDateTimeSchema,
})
export type ProviderModel = z.infer<typeof ProviderModelSchema>
