import type { WorkflowAttemptStatus, WorkflowRunStatus } from './execution.js'

const RUN_TRANSITIONS: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> =
  {
    pending: ['running', 'cancelled', 'interrupted'],
    running: [
      'waiting_user',
      'cancelling',
      'succeeded',
      'failed',
      'interrupted',
    ],
    waiting_user: ['running', 'cancelling', 'failed', 'interrupted'],
    cancelling: ['cancelled', 'failed', 'interrupted'],
    succeeded: [],
    failed: ['running', 'cancelled'],
    cancelled: [],
    interrupted: ['running', 'cancelled'],
  }
const ATTEMPT_TRANSITIONS: Record<
  WorkflowAttemptStatus,
  readonly WorkflowAttemptStatus[]
> = {
  pending: ['running', 'waiting_user', 'cancelled', 'interrupted'],
  running: ['succeeded', 'failed', 'cancelled', 'interrupted'],
  waiting_user: ['succeeded', 'rejected', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  rejected: [],
  cancelled: [],
  interrupted: [],
}

/** Resume is explicit; retry creates a new attempt rather than reviving a terminal one. */
export function canTransitionWorkflowRun(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}
export function canTransitionWorkflowAttempt(
  from: WorkflowAttemptStatus,
  to: WorkflowAttemptStatus,
): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to)
}
