import {
  DEFAULT_BROWSER_SETTINGS,
  BrowserSettingsSchema,
  browserRoute,
  normalizeBrowserUrl,
  type BrowserAction,
  type BrowserSettings,
} from '@reflexion-os-studio/contracts'
import type { createBrowserSettingsClient } from './browser-settings.js'
import type { createBrowserSurfaceClient } from './browser-surface.js'

/** One queue for preferences and session creation, so disablement cannot race navigation. */
export function createBrowserSessionClient(
  settingsClient: ReturnType<typeof createBrowserSettingsClient>,
  surface: ReturnType<typeof createBrowserSurfaceClient>,
) {
  let settings = DEFAULT_BROWSER_SETTINGS
  let pending: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }
  function publish(next: BrowserSettings): BrowserSettings {
    if (JSON.stringify(settings) !== JSON.stringify(next)) {
      settings = next
      for (const listener of listeners) listener()
    }
    return settings
  }
  async function read(): Promise<BrowserSettings> {
    return publish(await settingsClient.get())
  }
  return {
    getSnapshot: () => settings,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSettings: () => serial(read),
    updateSettings(next: BrowserSettings): Promise<BrowserSettings> {
      const validated = BrowserSettingsSchema.parse(next)
      return serial(async () => {
        if (validated.mode === 'system')
          await surface.control({ kind: 'close' })
        return publish(await settingsClient.update(validated))
      })
    },
    openLink(input: string): Promise<boolean> {
      const url = normalizeBrowserUrl(input)
      return serial(async () => {
        const [stored, capabilities] = await Promise.allSettled([
          read(),
          surface.capabilities(),
        ])
        if (
          stored.status === 'fulfilled' &&
          capabilities.status === 'fulfilled' &&
          capabilities.value.embeddedAvailable &&
          browserRoute(stored.value, url) === 'embedded'
        ) {
          const snapshot = await surface.open(url)
          if (snapshot.available) return true
        }
        await surface.openExternal(url)
        return false
      })
    },
    attach(isActive: () => boolean) {
      return serial(async () => {
        const stored = await read()
        if (!isActive() || stored.mode === 'system')
          return surface.control({ kind: 'status' })
        return surface.control({ kind: 'attach' })
      })
    },
    control(action: BrowserAction) {
      return serial(async () => {
        if (
          !['status', 'close', 'layout'].includes(action.kind) &&
          (await read()).mode === 'system'
        ) {
          throw new Error('内嵌浏览器已关闭，请在设置中启用')
        }
        return surface.control(action)
      })
    },
    navigate(input: string) {
      const url = normalizeBrowserUrl(input)
      return serial(async () => {
        const [stored, capabilities] = await Promise.allSettled([
          read(),
          surface.capabilities(),
        ])
        if (
          stored.status === 'rejected' ||
          stored.value.mode === 'system' ||
          capabilities.status === 'rejected' ||
          !capabilities.value.embeddedAvailable
        ) {
          await surface.openExternal(url)
          return null
        }
        // An address entered in the panel is an explicit user navigation, not a link route.
        return surface.control({ kind: 'navigate', url })
      })
    },
  }
}
