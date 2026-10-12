import type { CommandHandler } from '../command-utils.js'

export const browserSettingsCommandHandlers: Record<string, CommandHandler> = {
  'browser_settings.get': (_params, { store }) => ({
    settings: store.browserSettings.get(),
  }),
  'browser_settings.update': (params, { store }) => ({
    settings: store.browserSettings.upsert(
      params.settings as Parameters<typeof store.browserSettings.upsert>[0],
    ),
  }),
}
