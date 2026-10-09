import type { SessionData } from '../../api/sessions'
import type { HistoryCursor } from '@reflexion-os-studio/runtime-client'

export function compareHistoryPosition(
  a: HistoryCursor,
  b: HistoryCursor,
): number {
  return a.createdAt.localeCompare(b.createdAt) || a.rowId - b.rowId
}

function mergeById<T extends { id: string }>(older: T[], newer: T[]): T[] {
  return [
    ...new Map([...older, ...newer].map((item) => [item.id, item])).values(),
  ]
}

/** Refresh replaces the whole tail, including messages removed by edit/resend. */
export function mergeLatestHistory(
  current: SessionData | null,
  latest: SessionData,
): SessionData {
  if (
    !current ||
    current.session?.id !== latest.session?.id ||
    !latest.nextBefore
  )
    return latest
  const overlap = latest.messages.some(
    (message) => current.positions[message.id],
  )
  if (!overlap) return latest
  const start = latest.positions[latest.messages[0].id]
  const older = current.messages.filter(
    (message) =>
      compareHistoryPosition(current.positions[message.id], start) < 0,
  )
  const retainedRunIds = new Set(
    older.flatMap((message) => (message.runId ? [message.runId] : [])),
  )
  return {
    ...latest,
    messages: [...older, ...latest.messages],
    positions: Object.fromEntries([
      ...older.map(
        (message) => [message.id, current.positions[message.id]] as const,
      ),
      ...Object.entries(latest.positions),
    ]),
    nextBefore: current.nextBefore,
    runs: mergeById(
      current.runs.filter((run) => retainedRunIds.has(run.id)),
      latest.runs,
    ),
    toolCalls: mergeById(
      current.toolCalls.filter((call) =>
        older.some((message) => message.id === call.messageId),
      ),
      latest.toolCalls,
    ),
    runEvents: mergeById(
      current.runEvents.filter((event) => retainedRunIds.has(event.runId)),
      latest.runEvents,
    ),
  }
}

export function prependHistory(
  current: SessionData,
  older: SessionData,
): SessionData {
  return {
    ...current,
    messages: mergeById(older.messages, current.messages),
    positions: { ...older.positions, ...current.positions },
    nextBefore: older.nextBefore,
    runs: mergeById(older.runs, current.runs),
    toolCalls: mergeById(older.toolCalls, current.toolCalls),
    runEvents: mergeById(older.runEvents, current.runEvents),
  }
}
