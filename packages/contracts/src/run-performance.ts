import { z } from 'zod'

const milliseconds = z.number().finite().nonnegative()
const count = z.number().int().nonnegative()

/** Durations may overlap; summed worker time is not Run wall time. */
export const RunPerformanceSchema = z.object({
  version: z.literal(1),
  elapsedMs: milliseconds,
  modelMs: milliseconds,
  modelCalls: count,
  requestAttempts: count,
  requestRetries: count,
  firstDataWaitMs: milliseconds,
  firstDataSamples: count,
  approvalWaitMs: milliseconds,
  mutationWaitMs: milliseconds,
  toolExecutionMs: milliseconds,
  shellExecutionMs: milliseconds,
  toolBatchMs: milliseconds,
  toolCalls: count,
  toolFailures: count,
  editFailures: count,
  streamedReads: count,
})
export type RunPerformance = z.infer<typeof RunPerformanceSchema>
