import { z } from 'zod'

export const ReasoningEffortSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/)
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>
export const ReasoningOptionsSchema = z
  .array(
    z.object({
      label: z.string().trim().min(1).max(64),
      value: ReasoningEffortSchema,
    }),
  )
  .min(1)
  .max(32)
  .refine(
    (options) =>
      new Set(options.map((option) => option.value)).size === options.length,
    '思考等级值不能重复',
  )
export const DEFAULT_REASONING_OPTIONS = [
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
]
