import type { SystemRuntimeClient } from '../../system.js'
import type { ToolRegistry } from '@reflexion-os-studio/agent-core'
import type { Run } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { RunEventEmitter } from '../../events.js'
import type { PermissionGate, ApprovalGateway } from '../permissions/index.js'
import type { RootMutationCoordinator } from '../delegation/mutations.js'
import type { RunExecutionState } from './run-state.js'

export interface ToolExecutorInput {
  store: Store
  state: RunExecutionState
  run: Run
  gate: PermissionGate
  approvals: ApprovalGateway
  workspaceRoot: string | null
  registry: ToolRegistry
  emitter: RunEventEmitter
  /** Rust 沙箱 provider 标识（"none"/"seatbelt"/"bwrap"/"windows-token"）。 */
  system?: SystemRuntimeClient | null
  sandboxProvider: string | null
  permissionDomainId: string
  workflowRunId?: string
  beforeToolInvoke?: (toolName: string) => void
  rootRunId: string
  mutationCoordinator?: RootMutationCoordinator
}
