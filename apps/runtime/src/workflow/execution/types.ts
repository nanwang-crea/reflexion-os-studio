import type { RootMutationCoordinator } from '../../agent/delegation/mutations.js'
import type {
  ApprovalOverride,
  WorkflowAgentNode,
  WorkflowValues,
  PermissionPreset,
  ProviderProfile,
} from '@reflexion-os-studio/contracts'

/** Internal adapter boundary; lifecycle owner is Workflow, never a fake task call. */
export interface WorkflowAgentExecutor {
  execute(input: {
    workflowRunId: string
    attemptId: string
    projectId: string
    node: WorkflowAgentNode
    inputs: WorkflowValues
    providerId: string
    model: string
    profile: ProviderProfile
    permissionPreset: PermissionPreset
    approvalOverride: ApprovalOverride
    permissionDomainId: string
    mutationCoordinator: RootMutationCoordinator
    onBeforeModel: () => void
    onToolBatch: (toolNames: string[]) => void
    beforeToolInvoke: (toolName: string) => void
    onModelResult: (
      usage: import('@reflexion-os-studio/contracts').Usage,
      estimated?: boolean,
    ) => void
    signal: AbortSignal
  }): Promise<{
    agentRunId: string
    sessionId: string
    outputs: WorkflowValues
  }>
}
