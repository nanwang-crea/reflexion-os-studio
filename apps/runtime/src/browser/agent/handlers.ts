import { AgentBrowserSettingsSchema } from '@reflexion-os-studio/contracts'
import type { CommandHandler } from '../../command-utils.js'

export const agentBrowserSettingsCommandHandlers: Record<
  string,
  CommandHandler
> = {
  'agent_browser_runtime.status': (_params, { browser }) => {
    if (!browser) throw new Error('browser_unavailable')
    return { runtime: browser.runtime.status }
  },
  'agent_browser_runtime.install': (_params, { browser }) => {
    if (!browser) throw new Error('browser_unavailable')
    return { runtime: browser.runtime.install() }
  },
  'agent_browser_runtime.cancel': (_params, { browser }) => {
    if (!browser) throw new Error('browser_unavailable')
    return { runtime: browser.runtime.cancel() }
  },
  'agent_browser.close_all': async (_params, { browser }) => {
    await browser?.closeAll()
    return { closed: true }
  },
  'agent_browser_settings.get': (_params, { store }) => {
    const stored = store.browserSettings.get()
    return {
      settings: {
        source: stored.agentBrowserSource,
        lifetime: stored.agentBrowserLifetime,
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
      current.agentBrowserSource !== next.source ||
      current.agentBrowserDisplay !== next.display ||
      current.agentBrowserApproval !== next.approval ||
      (current.agentBrowserLifetime !== next.lifetime &&
        next.lifetime === 'run')
    )
      browser?.revoke()
    store.browserSettings.upsert({
      ...current,
      agentBrowserSource: next.source,
      agentBrowserLifetime: next.lifetime,
      agentBrowserEnabled: next.enabled,
      agentBrowserDisplay: next.display,
      agentBrowserApproval: next.approval,
    })
    return { settings: next }
  },
}
