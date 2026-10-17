import { z } from 'zod'

/** B1 浏览器能力报告：只描述适配器能力，不包含页面或网站数据。 */
export const BrowserCapabilitiesSchema = z.strictObject({
  platform: z.enum(['macos', 'windows', 'linux', 'unknown']),
  embeddedAvailable: z.boolean(),
  systemAvailable: z.boolean(),
  status: z.enum(['available', 'degraded', 'unavailable']),
  notice: z.string().nullable(),
  /** macOS CEF only: website-data encryption key stays in memory, not the login keychain. */
  mockKeychain: z.boolean().optional(),
  features: z
    .strictObject({
      find: z.boolean(),
      zoom: z.boolean(),
      print: z.boolean(),
      persistentSession: z.boolean(),
      dataClearing: z.boolean(),
      downloads: z.boolean(),
      passwordManagement: z.boolean(),
      contactFill: z.boolean(),
    })
    .optional(),
})
export type BrowserCapabilities = z.infer<typeof BrowserCapabilitiesSchema>
