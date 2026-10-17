import { setBrowserPanelOpen } from '../features/browser/panel-state'
import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  createBrowserSurfaceClient,
  createBrowserSessionClient,
  createBrowserSettingsClient,
} from '@reflexion-os-studio/runtime-client'
import { request } from './client'

export const browserSurface = createBrowserSurfaceClient({
  invoke: <T>(command: string, args?: unknown) =>
    invoke<T>(command, args as InvokeArgs),
  listen: <T>(event: string, handler: (event: { payload: T }) => void) =>
    listen<T>(event, handler),
})

export const browserSession = createBrowserSessionClient(
  createBrowserSettingsClient({ request }),
  browserSurface,
)

/** Ordinary links honor preferences; unavailable adapters fall back to the system. */
export async function openBrowserUrl(url: string): Promise<void> {
  if (await browserSession.openLink(url)) setBrowserPanelOpen(true)
}

/** Keychain mode is host-owned state; toggling persists and applies on next launch. */
export async function configureBrowserKeychain(mock: boolean): Promise<void> {
  await browserSurface.control({ kind: 'configurekeychain', mock })
}
