import {
  BrowserImportRequestSchema,
  BrowserImportResultSchema,
  BrowserCredentialsSchema,
  type BrowserImportRequest,
  BrowserActionSchema,
  BrowserSnapshotSchema,
  BrowserCapabilitiesSchema,
  normalizeBrowserUrl,
  type BrowserAction,
  type BrowserSnapshot,
} from '@reflexion-os-studio/contracts'
import type { RuntimeTransportOptions } from './transport.js'

/** Native Host facade, separate from RuntimeTransport and Agent tools. */
export function createBrowserSurfaceClient(options: RuntimeTransportOptions) {
  return {
    async capabilities() {
      return BrowserCapabilitiesSchema.parse(
        await options.invoke('browser_capabilities'),
      )
    },
    async open(url?: string): Promise<BrowserSnapshot> {
      return BrowserSnapshotSchema.parse(
        await options.invoke('browser_open', {
          url: url === undefined ? null : normalizeBrowserUrl(url),
        }),
      )
    },
    async control(action: BrowserAction): Promise<BrowserSnapshot> {
      const validated = BrowserActionSchema.parse(action)
      if (validated.kind === 'navigate')
        validated.url = normalizeBrowserUrl(validated.url)
      if (validated.kind === 'newtab' && validated.url !== undefined)
        validated.url = normalizeBrowserUrl(validated.url)
      return BrowserSnapshotSchema.parse(
        await options.invoke('browser_control', { action: validated }),
      )
    },
    async importFromBrowser(request: BrowserImportRequest) {
      return BrowserImportResultSchema.parse(
        await options.invoke('browser_import', {
          request: BrowserImportRequestSchema.parse(request),
        }),
      )
    },
    async credentials() {
      return BrowserCredentialsSchema.parse(
        await options.invoke('browser_credentials'),
      )
    },
    async fillCredential(id: number) {
      if (!Number.isInteger(id) || id < 0) throw new Error('无效的凭据编号')
      await options.invoke('browser_fill', { id })
    },
    async clearCredentials() {
      const cleared = await options.invoke('browser_clear_credentials')
      if (typeof cleared !== 'boolean') throw new Error('无效的删除结果')
      return cleared
    },
    subscribe(handler: (state: BrowserSnapshot) => void): Promise<() => void> {
      return options.listen<unknown>('browser:state', ({ payload }) => {
        const parsed = BrowserSnapshotSchema.safeParse(payload)
        if (parsed.success) handler(parsed.data)
      })
    },
    async openExternal(url: string): Promise<void> {
      await options.invoke('open_external', { url: normalizeBrowserUrl(url) })
    },
  }
}

export type {
  BrowserAction,
  BrowserSnapshot,
} from '@reflexion-os-studio/contracts'
