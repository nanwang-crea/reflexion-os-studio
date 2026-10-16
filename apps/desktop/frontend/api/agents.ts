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

export async function listAgentTemplates(
  projectId?: string | null,
): Promise<AgentTemplate[]> {
  const result = await request<{ templates: AgentTemplate[] }>(
    'agent_template.list',
    { projectId },
  )
  return result.templates
}

export function saveAgentTemplate(
  input: Omit<
    import('@reflexion-os-studio/runtime-client').AgentTemplateSaveParams,
    'requestId'
  >,
): Promise<{ template: AgentTemplate }> {
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

export function bulkUpdateAgentTemplates(
  input: Omit<
    import('@reflexion-os-studio/contracts').AgentTemplateBulkUpdateParams,
    'requestId'
  >,
): Promise<{ templates: AgentTemplate[] }> {
  return request('agent_template.bulk_update', input)
}

export function exportAgentTemplate(
  templateId: string,
  directory: string,
  includeSkills = false,
) {
  return request<{ path: string }>('agent_template.export', {
    templateId,
    directory,
    includeSkills,
  })
}

export function exportAgentTeam(
  input: Omit<
    import('@reflexion-os-studio/contracts').AgentTeamExportParams,
    'requestId'
  >,
) {
  return request<{ path: string; roleCount: number }>(
    'agent_template.team_export',
    input,
  )
}
export function importAgentTeam(
  archive: import('@reflexion-os-studio/contracts').AgentTeamShare,
  projectId: string | null,
) {
  return request<{ templates: AgentTemplate[]; teamId: string }>(
    'agent_template.team_import',
    { archive, projectId },
  )
}

export function previewAgentRolePackage(
  data: string,
  projectId: string | null,
) {
  return request<
    import('@reflexion-os-studio/contracts').AgentRolePackagePreview
  >('agent_template.package_preview', { data, projectId })
}
export function importAgentRolePackage(
  data: string,
  projectId: string | null,
  digest: string,
) {
  return request<{ template: AgentTemplate }>('agent_template.package_import', {
    data,
    projectId,
    digest,
  })
}
