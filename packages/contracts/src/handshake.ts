import { z } from 'zod'

export const PROTOCOL_VERSION = '1.1'

export const CapabilitySchema = z.enum([
  'chat',
  'system.bootstrap',
  'system.tools',
])
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
  // 沙箱 provider 标识（"none" | "windows-token" | "seatbelt" | "bwrap"）。
  // 开放字符串而非闭合枚举：新增 provider 不破坏握手校验；旧 sidecar 可省略。
  sandbox: z.string().optional(),
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
