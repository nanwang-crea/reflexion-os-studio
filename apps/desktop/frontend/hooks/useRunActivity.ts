import { useCallback, useEffect, useRef, useState } from 'react'

/** Run 级活动阶段：由事件驱动，对齐 Codex——不靠“内容长什么样”猜状态。 */
export type RunPhase = 'thinking' | 'answering' | 'tool'
export interface RunActivity {
  phase: RunPhase
  /** phase === 'tool' 时正在执行的工具名。 */
  toolName?: string
  /** 当前正在进行的 Provider 重试。 */
  retry?: {
    attempt: number
    maxRetries: number
    reason: string
    /** 本次重试前的退避等待时长（毫秒）；缺省为旧版事件，不展示倒计时。 */
    waitMs?: number
    /** 收到重试事件时的本地时间戳，用于倒计时换算。 */
    startedAt?: number
  }
}

/**
 * Run 级活动阶段（对齐 Codex）：由事件驱动，终态才清除（锁存）。
 * 用 ref 承载当前值，避免事件回调里的闭包读到过期 state。
 */
export function useRunActivity(): {
  runActivities: Record<string, RunActivity>
  setRunActivity: (runId: string, activity: RunActivity) => void
  clearRunActivity: (runId: string) => void
  clearAllRunActivities: () => void
  retryTick: number
} {
  const [runActivities, setRunActivities] = useState<
    Record<string, RunActivity>
  >({})
  const runActivitiesRef = useRef<Record<string, RunActivity>>({})
  const setRunActivity = useCallback((runId: string, activity: RunActivity) => {
    const next = {
      ...runActivitiesRef.current,
      [runId]: activity,
    }
    runActivitiesRef.current = next
    setRunActivities(next)
  }, [])
  const clearRunActivity = useCallback((runId: string) => {
    if (!(runId in runActivitiesRef.current)) return
    const next = { ...runActivitiesRef.current }
    delete next[runId]
    runActivitiesRef.current = next
    setRunActivities(next)
  }, [])
  const clearAllRunActivities = useCallback(() => {
    runActivitiesRef.current = {}
    setRunActivities({})
  }, [])

  // 重试倒计时心跳：RunActivity 里有 retry 时按固定节拍触发 tick，
  // 消费方用 Date.now() - startedAt 换算剩余秒数。
  const [retryTick, setRetryTick] = useState(0)
  const hasRetryActivity = Object.values(runActivities).some(
    (activity) => activity.retry !== undefined,
  )
  useEffect(() => {
    if (!hasRetryActivity) return
    const timer = setInterval(() => setRetryTick((value) => value + 1), 250)
    return () => clearInterval(timer)
  }, [hasRetryActivity])

  return {
    runActivities,
    setRunActivity,
    clearRunActivity,
    clearAllRunActivities,
    retryTick,
  }
}
