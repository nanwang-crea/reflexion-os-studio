import type { AgentSettings } from '@reflexion-os-studio/runtime-client'
import { request } from './client'

export function getAgentSettings(): Promise<{ settings: AgentSettings }> {
  return request<{ settings: AgentSettings }>('agent_settings.get', {})
}

export function updateAgentSettings(
  settings: AgentSettings,
): Promise<{ settings: AgentSettings }> {
  return request<{ settings: AgentSettings }>('agent_settings.update', {
    settings,
  })
}
