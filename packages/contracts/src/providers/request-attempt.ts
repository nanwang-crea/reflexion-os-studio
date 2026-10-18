import { z } from 'zod'

/** Request diagnostics and interrupted previews are UI history, never model input. */
export const ProviderRequestAttemptSchema = z.object({
  id: z.string().min(1),
  attempt: z.number().int().positive(),
  status: z.enum([
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  phase: z.enum(['connect', 'response', 'stream']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  durationMs: z.number().nonnegative(),
  responseStatus: z.number().int().optional(),
  providerRequestId: z.string().max(256).optional(),
  firstTextMs: z.number().nonnegative().optional(),
  firstReasoningMs: z.number().nonnegative().optional(),
  responseHeadersMs: z.number().nonnegative().optional(),
  firstDataMs: z.number().nonnegative().optional(),
  maxIdleMs: z.number().nonnegative(),
  receivedBytes: z.number().int().nonnegative(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  content: z.string(),
  reasoning: z.string(),
})
export type ProviderRequestAttempt = z.infer<
  typeof ProviderRequestAttemptSchema
>
