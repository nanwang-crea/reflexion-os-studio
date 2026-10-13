import type { CommandHandler } from '../command-utils.js'

export const browserSettingsCommandHandlers: Record<string, CommandHandler> = {
  'browser_settings.get': (_params, { store }) => ({
    settings: store.browserSettings.get(),
  }),
  'browser_settings.update': (params, { store }) => {
    const current = store.browserSettings.get()
    const settings = params.settings as Parameters<
      typeof store.browserSettings.upsert
    >[0]
    return {
      settings: store.browserSettings.upsert({
        ...settings,
        agentBrowserEnabled: current.agentBrowserEnabled,
        agentBrowserDisplay: current.agentBrowserDisplay,
        agentBrowserApproval: current.agentBrowserApproval,
      }),
    }
  },
}
