import { useSyncExternalStore } from 'react'
import type { BrowserSettings } from '@reflexion-os-studio/contracts'
import { browserSession } from './browser'
import { setBrowserPanelOpen } from '../features/browser/panel-state'

export function useBrowserSettings(): BrowserSettings {
  return useSyncExternalStore(
    browserSession.subscribe,
    browserSession.getSnapshot,
  )
}
export async function getBrowserSettings(): Promise<{
  settings: BrowserSettings
}> {
  return { settings: await browserSession.getSettings() }
}
export async function updateBrowserSettings(
  settings: BrowserSettings,
): Promise<{ settings: BrowserSettings }> {
  const stored = await browserSession.updateSettings(settings)
  if (stored.mode === 'system') setBrowserPanelOpen(false)
  return { settings: stored }
}
