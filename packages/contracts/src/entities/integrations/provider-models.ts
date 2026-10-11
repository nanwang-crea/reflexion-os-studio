import { z } from 'zod'
import { IsoDateTimeSchema } from '../shared.js'
import { ReasoningEffortSchema } from './reasoning.js'

/** Provider 下单个模型的能力与运行参数覆盖。null 表示继承 Provider 默认。 */
export const ProviderModelSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).nullable(),
  maxTokens: z.number().int().positive().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  contextBudget: z.number().int().positive().nullable(),
  reasoningEffort: ReasoningEffortSchema.nullable(),
  reasoningEffortSupported: z.boolean(),
  updatedAt: IsoDateTimeSchema,
})
export type ProviderModel = z.infer<typeof ProviderModelSchema>
