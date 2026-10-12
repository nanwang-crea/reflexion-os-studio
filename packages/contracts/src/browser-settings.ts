import { z } from 'zod'

/** Low-sensitivity preferences only; website data stays in the native adapter. */
export const BrowserSettingsSchema = z.strictObject({
  mode: z.enum(['embedded', 'system']),
  defaultRoute: z.enum(['embedded', 'system']),
  localRoute: z.enum(['embedded', 'system']).default('system'),
  showFullUrl: z.boolean().default(true),
})
export type BrowserSettings = z.infer<typeof BrowserSettingsSchema>

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  mode: 'embedded',
  defaultRoute: 'system',
  localRoute: 'system',
  showFullUrl: true,
}

export function isLocalBrowserUrl(input: string): boolean {
  const { hostname } = new URL(input)
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  )
}

export function browserRoute(
  settings: BrowserSettings,
  url: string,
): 'embedded' | 'system' {
  if (settings.mode === 'system') return 'system'
  return isLocalBrowserUrl(url) ? settings.localRoute : settings.defaultRoute
}
