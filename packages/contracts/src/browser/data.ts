import { z } from 'zod'
import { normalizeBrowserUrl } from './url.js'

export const BrowserOriginSchema = z
  .string()
  .max(8192)
  .refine((raw) => {
    try {
      return new URL(normalizeBrowserUrl(raw)).origin === raw
    } catch {
      return false
    }
  }, '必须为精确 HTTP / HTTPS origin')
export const BrowserVisitSchema = z.strictObject({
  id: z.string().min(1).max(200),
  url: z
    .string()
    .max(8192)
    .refine((url) => {
      try {
        return normalizeBrowserUrl(url) === url
      } catch {
        return false
      }
    }),
  title: z.string().max(500),
  origin: BrowserOriginSchema,
  visitedAt: z.string(),
})
export type BrowserVisit = z.infer<typeof BrowserVisitSchema>
export const BrowserContactSchema = z.strictObject({
  id: z.string().min(1).max(200),
  label: z.string().trim().min(1).max(100),
  name: z.string().max(200),
  email: z.string().email().max(254).or(z.literal('')),
  phone: z.string().max(100),
  address: z.string().max(1000),
})
export type BrowserContact = z.infer<typeof BrowserContactSchema>
export const BrowserDownloadSchema = z.strictObject({
  id: z.number().int().positive(),
  origin: BrowserOriginSchema,
  filename: z.string().max(255),
  path: z.string().nullable(),
  status: z.enum(['pending', 'active', 'completed', 'cancelled', 'failed']),
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  notice: z.string().nullable(),
})
export type BrowserDownload = z.infer<typeof BrowserDownloadSchema>
