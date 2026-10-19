import { z } from 'zod'
import { ReasoningOptionsSchema } from '../entities/integrations/reasoning.js'

const SupportSchema = z.object({ supported: z.boolean().optional() })
export const ModelMetadataSchema = z.object({
  id: z.string(),
  supported_parameters: z.array(z.string()).optional(),
  reasoning_options: ReasoningOptionsSchema.optional(),
  capabilities: z
    .object({
      thinking: SupportSchema.nullish(),
      effort: SupportSchema.extend({
        none: SupportSchema.optional(),
        minimal: SupportSchema.optional(),
        xhigh: SupportSchema.optional(),
        low: SupportSchema.optional(),
        medium: SupportSchema.optional(),
        high: SupportSchema.optional(),
        max: SupportSchema.optional(),
      }).nullish(),
    })
    .nullish(),
})
export const ModelMetadataPageSchema = z.object({
  data: z.array(z.unknown()).max(20000),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
})
