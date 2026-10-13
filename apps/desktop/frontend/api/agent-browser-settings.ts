import {
  AgentBrowserSettingsSchema,
  AgentBrowserRuntimeSchema,
  type AgentBrowserRuntime,
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

async function runtimeCommand(
  command:
    | 'agent_browser_runtime.status'
    | 'agent_browser_runtime.install'
    | 'agent_browser_runtime.cancel',
): Promise<AgentBrowserRuntime> {
  const result = await request<{ runtime: AgentBrowserRuntime }>(command)
  return AgentBrowserRuntimeSchema.parse(result.runtime)
}
export const getAgentBrowserRuntime = () =>
  runtimeCommand('agent_browser_runtime.status')
export const installAgentBrowserRuntime = () =>
  runtimeCommand('agent_browser_runtime.install')
export const cancelAgentBrowserRuntime = () =>
  runtimeCommand('agent_browser_runtime.cancel')
