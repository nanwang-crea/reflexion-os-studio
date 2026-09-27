import type {
  AgentDefinition,
  AgentTemplate,
  Delegation,
  MutationReceipt,
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

export async function getDelegationTree(
  rootRunId: string,
): Promise<Delegation[]> {
  const result = await request<{ delegations: Delegation[] }>(
    'delegation.tree',
    { rootRunId },
  )
  return result.delegations
}

export async function listMutationReceipts(
  rootRunId: string,
): Promise<MutationReceipt[]> {
  const result = await request<{ receipts: MutationReceipt[] }>(
    'mutation_receipt.list',
    { rootRunId },
  )
  return result.receipts
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

export async function listAgentTemplates(): Promise<AgentTemplate[]> {
  const result = await request<{ templates: AgentTemplate[] }>(
    'agent_template.list',
    {},
  )
  return result.templates
}

export function saveAgentTemplate(input: {
  id?: string
  name: string
  description: string
  systemPrompt: string
  enabled: boolean
  canDelegate: boolean
  allowedTools: string[]
}): Promise<{ template: AgentTemplate }> {
  return request<{ template: AgentTemplate }>('agent_template.save', input)
}

export function removeAgentTemplate(
  templateId: string,
): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>('agent_template.remove', { templateId })
}

export function cancelDelegation(
  delegationId: string,
): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('delegation.cancel', { delegationId })
}
