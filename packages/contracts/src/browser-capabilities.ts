import { z } from 'zod'

/** B1 浏览器能力报告：只描述适配器能力，不包含页面或网站数据。 */
export const BrowserCapabilitiesSchema = z.strictObject({
  platform: z.enum(['macos', 'windows', 'linux', 'unknown']),
  embeddedAvailable: z.boolean(),
  systemAvailable: z.boolean(),
  status: z.enum(['available', 'degraded', 'unavailable']),
  notice: z.string().nullable(),
})
export type BrowserCapabilities = z.infer<typeof BrowserCapabilitiesSchema>
