import {
  AgentBrowserSettingsSchema,
  type AgentBrowserSettings,
} from '@reflexion-os-studio/contracts'
import { request } from './client'

export async function getAgentBrowserSettings(): Promise<AgentBrowserSettings> {
  const result = await request<{ settings: AgentBrowserSettings }>(
    'agent_browser_settings.get',
  )
  return AgentBrowserSettingsSchema.parse(result.settings)
}
export async function updateAgentBrowserSettings(
  settings: AgentBrowserSettings,
): Promise<AgentBrowserSettings> {
  const result = await request<{ settings: AgentBrowserSettings }>(
    'agent_browser_settings.update',
    { settings: AgentBrowserSettingsSchema.parse(settings) },
  )
  return AgentBrowserSettingsSchema.parse(result.settings)
}
