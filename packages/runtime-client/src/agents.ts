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

export interface RuntimeAgentClient {
  listAgents(): Promise<{ agents: AgentDefinition[] }>
  listDelegations(sessionId: string): Promise<{ delegations: Delegation[] }>
  listDelegationsByParent(
    parentRunId: string,
  ): Promise<{ delegations: Delegation[] }>
}

/** Create a small typed facade when several agent queries share a transport. */
export function createRuntimeAgentClient(
  options: AgentClientRequestOptions & { newRequestId?: () => string },
): RuntimeAgentClient {
  const requestId = () => options.newRequestId?.() ?? options.requestId
  return {
    listAgents: () => listAgents({ ...options, requestId: requestId() }),
    listDelegations: (sessionId) =>
      listDelegations({ ...options, requestId: requestId() }, sessionId),
    listDelegationsByParent: (parentRunId) =>
      listDelegationsByParent(
        { ...options, requestId: requestId() },
        parentRunId,
      ),
  }
}

export type AgentDelegationUpdate = {
  delegationId: string
  status: DelegationStatus
  result?: string | null
  error?: string | null
}
