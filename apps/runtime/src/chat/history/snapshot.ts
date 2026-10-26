import type { Store } from '../../store/index.js'
import type {
  HistoryCursor,
  SessionHistory,
} from '@reflexion-os-studio/contracts'

export function readSessionHistory(
  store: Store,
  input: { sessionId: string; turns?: number; before?: HistoryCursor },
): SessionHistory {
  const { sessionId, turns = 10, before } = input
  const page = store.messages.listPage(sessionId, turns, before)
  const runIds = [
    ...new Set(
      page.messages.flatMap((message) =>
        message.runId ? [message.runId] : [],
      ),
    ),
  ]
  const runs = runIds.flatMap((id) => {
    const run = store.runs.get(id)
    return run ? [run] : []
  })
  return {
    session: store.sessions.get(sessionId),
    ...page,
    runs,
    toolCalls: store.toolCalls.listForPage(
      page.messages.map((message) => message.id),
      runIds,
    ),
    plans: store.plans.listCurrent(sessionId),
    runEvents: store.runEvents.listByRuns(runIds),
  }
}
