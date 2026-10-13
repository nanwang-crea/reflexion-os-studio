import type { Store } from '../../index.js'

/** Runs have already recovered. No model requests, tool calls or grants are replayed. */
export function recoverWorkflows(store: Store): void {
  for (const run of store.workflowRuns.active()) {
    if (
      !['pending', 'running', 'waiting_user', 'cancelling'].includes(run.status)
    )
      continue
    store.transaction(() => {
      for (const attempt of store.workflowAttempts.list(run.id))
        if (['pending', 'running', 'waiting_user'].includes(attempt.status))
          store.workflowAttempts.update({
            ...attempt,
            status: 'interrupted',
            errorCode: 'runtime_interrupted',
            completedAt: new Date().toISOString(),
          })
      for (const confirmation of store.workflowConfirmations.list(run.id))
        if (confirmation.status === 'pending')
          store.workflowConfirmations.resolve(confirmation.id, 'cancelled')
      const unknownTokens = store.workflowAttempts
        .list(run.id)
        .filter(
          (attempt) =>
            attempt.status === 'interrupted' &&
            attempt.modelPending &&
            attempt.agentRunId !== null &&
            store.runs.get(attempt.agentRunId!)?.status !== 'completed',
        )
        .reduce((sum, attempt) => sum + attempt.tokenBudget, 0)
      // Unknown in-flight model cost is charged conservatively, never reset for free.
      const elapsed =
        run.activeSince === null
          ? 0
          : Math.max(0, Date.now() - Date.parse(run.activeSince))
      store.workflowRuns.update({
        ...run,
        status:
          run.status === 'cancelling'
            ? run.errorCode
              ? 'failed'
              : 'cancelled'
            : 'interrupted',
        activeSince: null,
        executionMs: run.executionMs + elapsed,
        tokensUsed: run.tokensUsed + unknownTokens,
        tokensEstimated: run.tokensEstimated || unknownTokens > 0,
        errorCode: run.errorCode ?? 'runtime_interrupted',
      })
    })
  }
}
