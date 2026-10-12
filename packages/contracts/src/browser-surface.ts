import { z } from 'zod'
import { BrowserSiteRuleSchema, BrowserContactSchema } from './browser/data.js'

/** User Surface only; deliberately absent from Runtime/Agent command tables. */
export const BrowserActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('configure'),
    storageMode: z.enum(['temporary', 'persistent']),
    askDownloadLocation: z.boolean(),
    downloadDirectory: z.string().min(1).max(4096).nullable(),
    siteRules: z.array(BrowserSiteRuleSchema).max(500),
    contactAutofill: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('find'),
    text: z.string().max(1000),
    backwards: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('zoom'),
    factor: z.number().min(0.25).max(5),
  }),
  z.strictObject({ kind: z.literal('print') }),
  z.strictObject({
    kind: z.literal('fillcontact'),
    contact: BrowserContactSchema,
  }),
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
  progress: z.number().min(0).max(1).default(0),
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
  progress: z.number().min(0).max(1).default(0),
  url: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  revision: z.number().int().nonnegative(),
  notice: z.string().nullable(),
})
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>

export { normalizeBrowserUrl } from './browser/url.js'
