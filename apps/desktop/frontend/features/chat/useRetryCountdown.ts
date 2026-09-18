import { useEffect, useState } from 'react'
import type { RunActivity } from '../../hooks/useRunActivity'

type RetryInfo = NonNullable<RunActivity['retry']>

/** 退避剩余秒数；缺倒计时字段（旧版事件）返回 null，表示不展示倒计时。 */
function remainingSeconds(
  waitMs: number | undefined,
  startedAt: number | undefined,
): number | null {
  if (waitMs === undefined || startedAt === undefined) return null
  return Math.max(0, Math.ceil((waitMs - (Date.now() - startedAt)) / 1000))
}

/**
 * 重试倒计时：心跳只挂在真正展示倒计时的组件上（AGENTS.md §11 定时器有界），
 * 归零或重试消失即停表；不再由顶层 tick 驱动整棵会话树重渲染。
 */
export function useRetryCountdown(retry: RunActivity['retry']): number | null {
  const waitMs = retry?.waitMs
  const startedAt = retry?.startedAt
  const [remaining, setRemaining] = useState<number | null>(() =>
    remainingSeconds(waitMs, startedAt),
  )
  useEffect(() => {
    const initial = remainingSeconds(waitMs, startedAt)
    setRemaining(initial)
    if (waitMs === undefined || startedAt === undefined) return
    if (initial !== null && initial <= 0) return
    const timer = setInterval(() => {
      const value = remainingSeconds(waitMs, startedAt)
      setRemaining(value)
      if (value !== null && value <= 0) clearInterval(timer)
    }, 250)
    return () => clearInterval(timer)
  }, [waitMs, startedAt])
  return remaining
}

/** 重试状态行文案：有退避且未归零时展示剩余秒，否则回落到通用文案。 */
export function formatRetryLabel(
  retry: RetryInfo | undefined,
  remaining: number | null,
): string | null {
  if (retry === undefined) return null
  const progress = `正在重试（第 ${retry.attempt}/${retry.maxRetries} 次）`
  if (remaining === null) return `${progress}…`
  if (remaining > 0) return `${progress}… ${remaining} 秒后自动重试`
  return '正在重试…'
}
