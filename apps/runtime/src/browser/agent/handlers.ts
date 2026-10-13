import { AgentBrowserSettingsSchema } from '@reflexion-os-studio/contracts'
import type { CommandHandler } from '../../command-utils.js'

export const agentBrowserSettingsCommandHandlers: Record<
  string,
  CommandHandler
> = {
  'agent_browser_settings.get': (_params, { store }) => {
    const stored = store.browserSettings.get()
    return {
      settings: {
        enabled: stored.agentBrowserEnabled,
        display: stored.agentBrowserDisplay,
        approval: stored.agentBrowserApproval,
      },
    }
  },
  'agent_browser_settings.update': (params, { store, browser }) => {
    const next = AgentBrowserSettingsSchema.parse(params.settings)
    const current = store.browserSettings.get()
    if (
      !next.enabled ||
      current.agentBrowserDisplay !== next.display ||
      current.agentBrowserApproval !== next.approval
    )
      browser?.revoke()
    store.browserSettings.upsert({
      ...current,
      agentBrowserEnabled: next.enabled,
      agentBrowserDisplay: next.display,
      agentBrowserApproval: next.approval,
    })
    return { settings: next }
  },
}
