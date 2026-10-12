import type { DatabaseSync } from 'node:sqlite'
import {
  BrowserSettingsSchema,
  DEFAULT_BROWSER_SETTINGS,
  type BrowserSettings,
} from '@reflexion-os-studio/contracts'

/** B1 低敏浏览器偏好；不承载凭据、Cookie 或网站权限。 */
export class BrowserSettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  get(): BrowserSettings {
    const row = this.db
      .prepare('SELECT settings_json FROM browser_settings WHERE id = 1')
      .get() as { settings_json: string } | undefined
    if (!row) return { ...DEFAULT_BROWSER_SETTINGS }
    return this.parse(row.settings_json)
  }

  upsert(settings: BrowserSettings): BrowserSettings {
    const canonical = BrowserSettingsSchema.parse(settings)
    this.db
      .prepare(
        `INSERT INTO browser_settings (id, settings_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           settings_json = excluded.settings_json,
           updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(canonical), new Date().toISOString())
    return this.get()
  }

  private parse(raw: string): BrowserSettings {
    try {
      const stored = JSON.parse(raw)
      // Migrate the initial B1 draft without discarding explicit route choices.
      if ('allowLocalhost' in stored || 'homepageUrl' in stored) {
        return BrowserSettingsSchema.parse({
          mode: stored.mode,
          defaultRoute: stored.defaultRoute,
          localRoute: stored.allowLocalhost ? stored.defaultRoute : 'system',
          showFullUrl: true,
        })
      }
      return BrowserSettingsSchema.parse(stored)
    } catch {
      return { ...DEFAULT_BROWSER_SETTINGS }
    }
  }
}
