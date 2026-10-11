import { setBrowserPanelOpen } from '../features/browser/panel-state'
import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createBrowserSurfaceClient } from '@reflexion-os-studio/runtime-client'

export const browserSurface = createBrowserSurfaceClient({
  invoke: <T>(command: string, args?: unknown) =>
    invoke<T>(command, args as InvokeArgs),
  listen: <T>(event: string, handler: (event: { payload: T }) => void) =>
    listen<T>(event, handler),
})

/** Normal builds and platforms without verified native adapters fall back. */
export async function openBrowserUrl(url: string): Promise<void> {
  const state = await browserSurface.open(url)
  if (state.available) setBrowserPanelOpen(true)
  if (!state.available) await browserSurface.openExternal(url)
}
