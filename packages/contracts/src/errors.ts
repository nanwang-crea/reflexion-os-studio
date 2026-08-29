import { z } from 'zod'

export const RuntimeErrorCodeSchema = z.enum([
  'configuration',
  'authentication',
  'rate_limit',
  'timeout',
  'network',
  'unsupported',
  'provider',
  'invalid_request',
  'internal',
])
export type RuntimeErrorCode = z.infer<typeof RuntimeErrorCodeSchema>

export const RuntimeErrorSchema = z.object({
  code: RuntimeErrorCodeSchema,
  message: z.string(),
  data: z.unknown().optional(),
})
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>
