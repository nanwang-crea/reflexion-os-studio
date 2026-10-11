import { z } from 'zod'

/** User Surface only; deliberately absent from Runtime/Agent command tables. */
export const BrowserActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('navigate'),
    url: z.string().min(1).max(8192),
  }),
  z.strictObject({
    kind: z.literal('newtab'),
    url: z.string().min(1).max(8192).optional(),
  }),
  z.strictObject({
    kind: z.enum(['selecttab', 'closetab']),
    tabId: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('layout'),
    x: z.number().finite().min(0).max(100000),
    y: z.number().finite().min(0).max(100000),
    width: z.number().finite().min(0).max(100000),
    height: z.number().finite().min(0).max(100000),
    visible: z.boolean(),
  }),
  z.strictObject({
    kind: z.enum([
      'attach',
      'status',
      'back',
      'forward',
      'reload',
      'stop',
      'close',
    ]),
  }),
])
export type BrowserAction = z.infer<typeof BrowserActionSchema>

export const BrowserTabSchema = z.strictObject({
  id: z.number().int().positive(),
  title: z.string(),
  status: z.enum(['idle', 'loading', 'ready', 'failed', 'unavailable']),
  url: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  notice: z.string().nullable(),
})
export const BrowserSnapshotSchema = z.strictObject({
  tabs: z.array(BrowserTabSchema).max(24),
  activeTabId: z.number().int().positive().nullable(),
  available: z.boolean(),
  status: z.enum(['idle', 'loading', 'ready', 'failed', 'unavailable']),
  url: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  revision: z.number().int().nonnegative(),
  notice: z.string().nullable(),
})
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>

/** Address-bar normalization. The Host independently enforces the boundary. */
export function normalizeBrowserUrl(input: string): string {
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new Error('请输入有效的网址')
  const trimmed = input.trim()
  if (
    !trimmed ||
    trimmed.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(trimmed)
  )
    throw new Error('请输入有效的网址')
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
  // A hostname:port is an address, not an application protocol.
  const hostPort =
    /^(?:localhost|[a-z\d.-]+|\[[a-f\d:]+\]):\d+(?:[/?#]|$)/i.test(trimmed)
  const url = new URL(
    explicitScheme && !hostPort ? trimmed : `https://${trimmed}`,
  )
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new Error('只支持不含账号密码的 HTTP / HTTPS 网址')
  return url.href
}
