import type { Message, Run, Session } from '@reflexion-os-studio/runtime-client'
import type { SessionData } from '../../api/sessions'

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id)
  if (index === -1) return [...items, next]
  const copy = items.slice()
  copy[index] = next
  return copy
}

/**
 * 事件载荷的即时合并：message.created / run.started 本身已携带完整的
 * Message/Run，不必再等一次整页 session.get。发送后运行时可能长时间
 * 同步重建上下文（大会话可达数秒），整页刷新会排在其后，导致「点了发送
 * 什么也不出现」的卡顿感；这里直接上屏，后续规范刷新只做对账。
 */
export function mergeLiveMessage(
  current: SessionData,
  message: Message,
): SessionData {
  if (current.session?.id !== message.sessionId) return current
  return { ...current, messages: upsertById(current.messages, message) }
}

export function mergeLiveRun(current: SessionData, run: Run): SessionData {
  if (current.session?.id !== run.sessionId) return current
  return { ...current, runs: upsertById(current.runs, run) }
}

/** session.updated 目前只承载标题变化；就地更新，避免为改名重取整页历史。 */
export function mergeLiveSession(
  current: SessionData,
  session: Session,
): SessionData {
  if (current.session?.id !== session.id) return current
  return { ...current, session }
}
