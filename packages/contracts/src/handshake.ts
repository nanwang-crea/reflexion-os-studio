import { z } from 'zod'

export const PROTOCOL_VERSION = '1.0'

export const CapabilitySchema = z.enum(['chat', 'system.bootstrap'])
export type Capability = z.infer<typeof CapabilitySchema>

export const SidecarStateSchema = z.enum([
  'starting',
  'ready',
  'unavailable',
  'stopped',
  'error',
])
export type SidecarState = z.infer<typeof SidecarStateSchema>

export const ReadyParamsSchema = z.object({
  protocolVersion: z.string(),
  runtimeVersion: z.string(),
  capabilities: z.array(CapabilitySchema),
})
export type ReadyParams = z.infer<typeof ReadyParamsSchema>

export const RuntimeStatusSchema = z.object({
  state: SidecarStateSchema,
  protocolVersion: z.string(),
  runtimeVersion: z.string(),
  capabilities: z.array(CapabilitySchema),
  chatAvailable: z.boolean(),
  systemAvailable: z.boolean(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
})
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>
