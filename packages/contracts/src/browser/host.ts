import { z } from 'zod'

/** Private Runtime↔Host protocol; never registered as an Agent or renderer command. */
export const HostBrowserRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('open'),
    lease: z.uuid(),
    sessionId: z.string().min(1).max(256),
    origin: z
      .url()
      .refine(
        (value) => new URL(value).origin === value && /^https?:/.test(value),
      ),
  }),
  z.strictObject({ kind: z.enum(['check', 'close']), lease: z.uuid() }),
])
export type HostBrowserRequest = z.infer<typeof HostBrowserRequestSchema>
export const HostBrowserLeaseSchema = z.strictObject({
  endpoint: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/),
  marker: z.string().startsWith('about:blank#'),
  tabId: z.number().int().positive(),
})
export type HostBrowserLease = z.infer<typeof HostBrowserLeaseSchema>
export const HostBrowserControlSchema = z.strictObject({
  lease: z.uuid(),
  paused: z.boolean(),
})
