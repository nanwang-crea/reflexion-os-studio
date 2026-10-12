import {
  BrowserSettingsSchema,
  type BrowserSettings,
} from '@reflexion-os-studio/contracts'
import type { RuntimeTransport } from './transport.js'

export function createBrowserSettingsClient(
  transport: Pick<RuntimeTransport, 'request'>,
) {
  return {
    async get(): Promise<BrowserSettings> {
      const result = await transport.request<{ settings: BrowserSettings }>(
        'browser_settings.get',
        { requestId: globalThis.crypto.randomUUID() },
      )
      return BrowserSettingsSchema.parse(result.settings)
    },
    async update(settings: BrowserSettings): Promise<BrowserSettings> {
      const result = await transport.request<{ settings: BrowserSettings }>(
        'browser_settings.update',
        {
          requestId: globalThis.crypto.randomUUID(),
          settings: BrowserSettingsSchema.parse(settings),
        },
      )
      return BrowserSettingsSchema.parse(result.settings)
    },
  }
}
