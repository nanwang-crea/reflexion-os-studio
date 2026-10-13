import { chromium, type LaunchOptions } from 'playwright'
import type { AgentBrowserLaunch } from '@reflexion-os-studio/contracts'

/** Fallback is confined to launch; approved navigation is never replayed. */
export async function launchAgentBrowser(
  config: AgentBrowserLaunch,
  options: LaunchOptions,
  isCurrent: () => boolean,
  launch = chromium.launch.bind(chromium),
) {
  try {
    return await launch({
      ...options,
      channel: config.channel,
      ...(config.executablePath
        ? { executablePath: config.executablePath }
        : {}),
    })
  } catch (error) {
    if (!isCurrent()) throw new Error('browser_closed')
    if (config.channel !== 'chrome') throw error
    if (!config.fallbackManaged)
      throw new Error('browser_system_chrome_unavailable')
    return launch({ ...options, channel: 'chromium' })
  }
}
