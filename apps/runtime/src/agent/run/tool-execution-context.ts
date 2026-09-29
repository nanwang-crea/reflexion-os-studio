import type { ToolExecutorInput } from './tool-executor.js'
import type {
  ApprovalRequestInput,
  ApprovalOutcome,
} from '../permissions/index.js'
import type {
  ApprovalContextView,
  ApprovalRisk,
  ApprovalSubject,
  JsonValue,
  SandboxPolicy,
} from '@reflexion-os-studio/contracts'
import { displayCommand } from '../permissions/index.js'

const READ_FILE_OPERATIONS = new Set([
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
])

export function argsRecord(args: JsonValue): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    return {}
  return args as Record<string, unknown>
}

export function fileSandboxFor(toolName: string): SandboxPolicy {
  return READ_FILE_OPERATIONS.has(toolName) ? 'read-only' : 'workspace-write'
}

export function riskFor(
  subject: ApprovalSubject,
  escalation: boolean,
  network: boolean,
  toolName: string,
): ApprovalRisk {
  if (escalation || network) return 'elevated'
  if (toolName === 'file.delete' || toolName === 'file.move') return 'warning'
  if (subject.kind === 'shell-command' && subject.prefixCandidate === null) {
    return 'warning'
  }
  return 'normal'
}

export function buildApprovalContext(input: {
  workspaceRoot: string | null
  sandbox: SandboxPolicy
  sandboxProvider: string | null
  network: boolean
  escalation: boolean
  justification?: string
  agent?: ApprovalContextView['agent']
}): ApprovalContextView {
  const root = input.workspaceRoot
  const basename =
    root === null
      ? null
      : (root.split(/[\\/]/).filter(Boolean).pop() ?? root ?? null)
  return {
    displayCwd: basename === null ? null : `…/${basename}`,
    workspaceScope: root === null ? 'none' : 'inside',
    sandbox: input.sandbox,
    sandboxProvider: input.sandboxProvider,
    network: input.network,
    escalation: input.escalation,
    justification: input.justification
      ? displayCommand(input.justification)
      : null,
    ...(input.agent ? { agent: input.agent } : {}),
  }
}

/** Maintain Run/Turn states while concurrent approval requests are pending. */
export async function requestToolApproval(
  input: ToolExecutorInput,
  request: ApprovalRequestInput,
): Promise<ApprovalOutcome> {
  const { store, state, run } = input
  const toolCallId = request.toolCallId
  store.runs.setIntermediateStatus(run.id, 'awaiting_approval')
  if (state.currentTurnId !== null) {
    store.turnExecutions.transition(
      state.currentTurnId,
      'awaiting_permission',
      { pendingApprovalId: toolCallId },
    )
  }
  try {
    return await input.approvals.request(request)
  } finally {
    // 并行工具轮次:还有其它调用在等审批时保持 awaiting_approval，
    // 否则才回置 running，避免 Run 状态错报。
    if (!input.approvals.hasPendingRun(run.id)) {
      store.runs.setIntermediateStatus(run.id, 'running')
      if (state.currentTurnId !== null) {
        store.turnExecutions.transition(
          state.currentTurnId,
          'executing_tools',
          { pendingApprovalId: null },
        )
      }
    }
  }
}
