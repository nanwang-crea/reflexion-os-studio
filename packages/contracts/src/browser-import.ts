import { z } from 'zod'

export const BrowserImportRequestSchema = z
  .strictObject({
    source: z.enum(['chrome', 'edge']),
    profile: z.string().regex(/^(Default|Profile [1-9]\d{0,3})$/),
    cookies: z.boolean(),
    passwords: z.boolean(),
  })
  .refine((value) => value.cookies || value.passwords, '请选择导入内容')
export type BrowserImportRequest = z.infer<typeof BrowserImportRequestSchema>
export const BrowserImportResultSchema = z.strictObject({
  cookies: z.number().int().nonnegative(),
  passwords: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  cancelled: z.boolean(),
  notice: z.string(),
})
export const BrowserCredentialSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  origin: z.string(),
  label: z.string(),
})
export const BrowserCredentialsSchema = z
  .array(BrowserCredentialSchema)
  .max(10000)
