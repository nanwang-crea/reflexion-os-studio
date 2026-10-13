import { z } from 'zod'
import { BrowserSiteRuleSchema } from './browser/data.js'
import { normalizeBrowserUrl } from './browser/url.js'

/** Low-sensitivity preferences only; website data stays in the native adapter. */
export const BrowserSettingsSchema = z.strictObject({
  agentBrowserEnabled: z.boolean().default(false),
  mode: z.enum(['embedded', 'system']),
  defaultRoute: z.enum(['embedded', 'system']),
  localRoute: z.enum(['embedded', 'system']).default('system'),
  showFullUrl: z.boolean().default(true),
  searchEngine: z.enum(['google', 'bing', 'duckduckgo']).default('google'),
  homepage: z.enum(['blank', 'google', 'bing', 'duckduckgo']).default('blank'),
  newTabPage: z.enum(['blank', 'homepage']).default('blank'),
  storageMode: z.enum(['temporary', 'persistent']).default('temporary'),
  saveHistory: z.boolean().default(false),
  contactAutofill: z.boolean().default(false),
  askDownloadLocation: z.boolean().default(true),
  downloadDirectory: z.string().min(1).max(4096).nullable().default(null),
  siteRules: z.array(BrowserSiteRuleSchema).max(500).default([]),
})
export type BrowserSettings = z.infer<typeof BrowserSettingsSchema>

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings =
  BrowserSettingsSchema.parse({
    mode: 'embedded',
    defaultRoute: 'system',
  })

const SEARCH_URLS = {
  google: 'https://www.google.com/search',
  bing: 'https://www.bing.com/search',
  duckduckgo: 'https://duckduckgo.com/',
}
export function browserHomeUrl(settings: BrowserSettings): string | undefined {
  return settings.homepage === 'blank'
    ? undefined
    : new URL(SEARCH_URLS[settings.homepage]).origin + '/'
}
export function browserAddressUrl(
  input: string,
  settings: BrowserSettings,
): string {
  const value = input.trim()
  // An explicit scheme or recognizable host must not be converted to a search on failure.
  const address =
    /^[a-z][a-z\d+.-]*:/i.test(value) ||
    /^(?:localhost|\[[a-f\d:]+\]|[^\s/]+\.[^\s/]+)(?::\d+)?(?:[/?#]|$)/i.test(
      value,
    )
  if (address) return normalizeBrowserUrl(value)
  if (!value || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('请输入网址或搜索词')
  const url = new URL(SEARCH_URLS[settings.searchEngine])
  url.searchParams.set('q', value)
  return url.href
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
