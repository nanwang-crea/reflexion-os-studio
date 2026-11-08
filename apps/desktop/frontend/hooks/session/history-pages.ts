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
  return appendLocalTail(current, mergeSnapshot(current, latest))
}

/**
 * 事件即时合并可能比某个仍在飞行中的整页快照更新（如上一 Run 的终态刷新
 * 与新消息的 message.created 交错）。保留快照里尚不存在、但 createdAt
 * 晚于快照最后一条的本地消息，避免乐观上屏的内容被旧响应吞掉再闪回。
 */
function appendLocalTail(
  current: SessionData | null,
  merged: SessionData,
): SessionData {
  if (!current || current.session?.id !== merged.session?.id) return merged
  const known = new Set(merged.messages.map((message) => message.id))
  const lastCreatedAt = merged.messages.at(-1)?.createdAt ?? ''
  const tail = current.messages.filter(
    (message) => !known.has(message.id) && message.createdAt > lastCreatedAt,
  )
  if (tail.length === 0) return merged
  const tailRunIds = new Set(
    tail.flatMap((message) => (message.runId ? [message.runId] : [])),
  )
  return {
    ...merged,
    messages: [...merged.messages, ...tail],
    runs: mergeById(
      merged.runs,
      current.runs.filter((run) => tailRunIds.has(run.id)),
    ),
  }
}

function mergeSnapshot(
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
  const start = latest.positions[latest.messages[0]?.id]
  if (start === undefined) return latest
  // 即时上屏（message.created/live merge）的消息还没有 positions 记录：
  // 它们不是“更老的历史”，交给 appendLocalTail 按 createdAt 处理；
  // 直接比较 undefined.createdAt 会在发送后的首次刷新时抛错白屏。
  const older = current.messages.filter((message) => {
    const position = current.positions[message.id]
    return position !== undefined && compareHistoryPosition(position, start) < 0
  })
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
