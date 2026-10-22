import { z } from 'zod'

const ms = z.number().finite().nonnegative()
/** Missing phases remain unknown, particularly for historical calls. */
export const ToolCallTimingSchema = z.object({
  version: z.literal(1),
  executionStartedAt: z.string().datetime().optional(),
  approvalWaitMs: ms.optional(),
  mutationWaitMs: ms.optional(),
  executionMs: ms.optional(),
})
export type ToolCallTiming = z.infer<typeof ToolCallTimingSchema>
