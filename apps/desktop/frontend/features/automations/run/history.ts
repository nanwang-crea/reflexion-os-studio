import type { WorkflowRunSummary } from '@reflexion-os-studio/contracts'

/** Run history has no deletion API; refresh the head without discarding loaded pages. */
export function mergeWorkflowRuns(
  current: WorkflowRunSummary[],
  incoming: WorkflowRunSummary[],
  position: 'latest' | 'older',
): WorkflowRunSummary[] {
  const values = new Map(current.map((run) => [run.id, run]))
  for (const run of incoming) {
    const previous = values.get(run.id)
    if (!previous || previous.stateVersion <= run.stateVersion)
      values.set(run.id, run)
  }
  const ordered =
    position === 'latest'
      ? [...incoming, ...current]
      : [...current, ...incoming]
  return [...new Set(ordered.map((run) => run.id))].map((id) => values.get(id)!)
}
