import type {
  AgentDefinition,
  Delegation,
  DelegationStatus,
} from '@reflexion-os-studio/contracts'
import type { RuntimeTransport } from './transport.js'

export type { AgentDefinition, Delegation, DelegationStatus }

export interface AgentClientRequestOptions {
  transport: RuntimeTransport
  requestId: string
}

/** List agents that are available for delegation. */
export function listAgents({
  transport,
  requestId,
}: AgentClientRequestOptions): Promise<{ agents: AgentDefinition[] }> {
  return transport.request('agent.list', { requestId })
}

export function setAgentEnabled(
  { transport, requestId }: AgentClientRequestOptions,
  agentId: string,
  enabled: boolean,
): Promise<{ agent: AgentDefinition }> {
  return transport.request('agent.set_enabled', {
    requestId,
    agentId,
    enabled,
  })
}

/** List delegations belonging to a session. */
export function listDelegations(
  { transport, requestId }: AgentClientRequestOptions,
  sessionId: string,
): Promise<{ delegations: Delegation[] }> {
  return transport.request('delegation.list', { requestId, sessionId })
}

/** List child delegations created by a parent run. */
export function listDelegationsByParent(
  { transport, requestId }: AgentClientRequestOptions,
  parentRunId: string,
): Promise<{ delegations: Delegation[] }> {
  return transport.request('delegation.list_by_parent', {
    requestId,
    parentRunId,
  })
}

export function cancelDelegation(
  { transport, requestId }: AgentClientRequestOptions,
  delegationId: string,
): Promise<{ accepted: boolean }> {
  return transport.request('delegation.cancel', { requestId, delegationId })
}

export interface RuntimeAgentClient {
  listAgents(): Promise<{ agents: AgentDefinition[] }>
  setAgentEnabled(
    agentId: string,
    enabled: boolean,
  ): Promise<{ agent: AgentDefinition }>
  listDelegations(sessionId: string): Promise<{ delegations: Delegation[] }>
  listDelegationsByParent(
    parentRunId: string,
  ): Promise<{ delegations: Delegation[] }>
  cancelDelegation(delegationId: string): Promise<{ accepted: boolean }>
}

/** Create a small typed facade when several agent queries share a transport. */
export function createRuntimeAgentClient(
  options: AgentClientRequestOptions & { newRequestId?: () => string },
): RuntimeAgentClient {
  const requestId = () => options.newRequestId?.() ?? options.requestId
  return {
    listAgents: () => listAgents({ ...options, requestId: requestId() }),
    setAgentEnabled: (agentId, enabled) =>
      setAgentEnabled({ ...options, requestId: requestId() }, agentId, enabled),
    listDelegations: (sessionId) =>
      listDelegations({ ...options, requestId: requestId() }, sessionId),
    listDelegationsByParent: (parentRunId) =>
      listDelegationsByParent(
        { ...options, requestId: requestId() },
        parentRunId,
      ),
    cancelDelegation: (delegationId) =>
      cancelDelegation({ ...options, requestId: requestId() }, delegationId),
  }
}

export type AgentDelegationUpdate = {
  delegationId: string
  status: DelegationStatus
  result?: string | null
  error?: string | null
}
