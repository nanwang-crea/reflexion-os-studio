import type {
  AgentDefinition,
  Delegation,
} from '@reflexion-os-studio/runtime-client'
import { request } from './client'

/** 列出某会话的所有委派记录（父子 Run 关联查询，实时刷新用）。 */
export async function listDelegations(
  sessionId: string,
): Promise<Delegation[]> {
  const result = await request<{ delegations: Delegation[] }>(
    'delegation.list',
    { sessionId },
  )
  return result.delegations
}

export async function listAgents(): Promise<AgentDefinition[]> {
  const result = await request<{ agents: AgentDefinition[] }>('agent.list', {})
  return result.agents
}

export function setAgentEnabled(
  agentId: string,
  enabled: boolean,
): Promise<{ agent: AgentDefinition }> {
  return request<{ agent: AgentDefinition }>('agent.set_enabled', {
    agentId,
    enabled,
  })
}

export function cancelDelegation(
  delegationId: string,
): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('delegation.cancel', { delegationId })
}
