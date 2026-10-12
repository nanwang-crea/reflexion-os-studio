import {
  DEFAULT_BROWSER_SETTINGS,
  BrowserSettingsSchema,
  browserRoute,
  browserAddressUrl,
  browserHomeUrl,
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
  let configured = ''
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
  async function configure(next: BrowserSettings): Promise<void> {
    const capabilities = await surface.capabilities()
    if (!capabilities.embeddedAvailable || !capabilities.features) return
    if (
      next.storageMode === 'persistent' &&
      !capabilities.features.persistentSession
    )
      throw new Error('本平台不支持独立持久浏览配置')
    const action = {
      kind: 'configure' as const,
      storageMode: next.storageMode,
      askDownloadLocation: next.askDownloadLocation,
      downloadDirectory: next.downloadDirectory,
      siteRules: next.siteRules,
      contactAutofill: next.contactAutofill,
    }
    const signature = JSON.stringify(action)
    if (signature !== configured) {
      await surface.control(action)
      configured = signature
    }
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
        const previous = await read()
        await configure(validated)
        if (validated.mode === 'system')
          await surface.control({ kind: 'close' })
        try {
          return publish(await settingsClient.update(validated))
        } catch (error) {
          await configure(previous).catch(() => {})
          throw error
        }
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
          await configure(stored.value)
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
        await configure(stored)
        if (!isActive()) return surface.control({ kind: 'status' })
        return surface.control({ kind: 'attach' })
      })
    },
    control(action: BrowserAction) {
      return serial(async () => {
        if (['status', 'close', 'layout'].includes(action.kind))
          return surface.control(action)
        if (
          !['status', 'close', 'layout'].includes(action.kind) &&
          (await read()).mode === 'system'
        ) {
          throw new Error('内嵌浏览器已关闭，请在设置中启用')
        }
        const stored = settings
        await configure(stored)
        if (
          action.kind === 'newtab' &&
          !action.url &&
          stored.newTabPage === 'homepage'
        ) {
          return surface.control({ ...action, url: browserHomeUrl(stored) })
        }
        return surface.control(action)
      })
    },
    clearData(websiteData: boolean, cache: boolean) {
      return serial(async () => {
        await configure(await read())
        await surface.clearData(websiteData, cache)
      })
    },
    navigate(input: string) {
      return serial(async () => {
        const [stored, capabilities] = await Promise.allSettled([
          read(),
          surface.capabilities(),
        ])
        const url = browserAddressUrl(
          input,
          stored.status === 'fulfilled'
            ? stored.value
            : DEFAULT_BROWSER_SETTINGS,
        )
        if (
          stored.status === 'rejected' ||
          stored.value.mode === 'system' ||
          capabilities.status === 'rejected' ||
          !capabilities.value.embeddedAvailable
        ) {
          await surface.openExternal(url)
          return null
        }
        await configure(stored.value)
        // An address entered in the panel is an explicit user navigation, not a link route.
        return surface.control({ kind: 'navigate', url })
      })
    },
  }
}
