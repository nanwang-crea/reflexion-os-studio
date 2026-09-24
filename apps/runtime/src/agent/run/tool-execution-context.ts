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
  }
}
