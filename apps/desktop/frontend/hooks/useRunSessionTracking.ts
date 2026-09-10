import { useCallback, useRef, useState } from 'react'

/**
 * 会话级 Run 状态跟踪：运行中计数、完成/失败标记（持久保留）。
 * 标记由用户点击会话行清除（clearSessionStatus），不自动消退。
 * 由 bootstrap 事件回调驱动（run.started / run.completed / run.failed / run.cancelled）。
 */
export function useRunSessionTracking(): {
  runningSessionIds: string[]
  completedSessionIds: string[]
  failedSessionIds: string[]
  onRunStarted: (runId: string, sessionId: string) => void
  onRunSettled: (
    status: 'run.completed' | 'run.failed' | 'run.cancelled',
    runId: string,
  ) => void
  /** 点击会话行视为确认：清除该会话的完成/失败标记。 */
  clearSessionStatus: (sessionId: string) => void
} {
  const [runningSessionIds, setRunningSessionIds] = useState<string[]>([])
  const [completedSessionIds, setCompletedSessionIds] = useState<string[]>([])
  const [failedSessionIds, setFailedSessionIds] = useState<string[]>([])
  const runSessionsRef = useRef<Record<string, string>>({})
  const activeSessionRunsRef = useRef<Record<string, number>>({})

  const onRunStarted = useCallback((runId: string, sessionId: string): void => {
    runSessionsRef.current[runId] = sessionId
    activeSessionRunsRef.current[sessionId] =
      (activeSessionRunsRef.current[sessionId] ?? 0) + 1
    setRunningSessionIds(Object.keys(activeSessionRunsRef.current))
    setFailedSessionIds((ids) => ids.filter((id) => id !== sessionId))
    setCompletedSessionIds((ids) => ids.filter((id) => id !== sessionId))
  }, [])

  const onRunSettled = useCallback(
    (
      status: 'run.completed' | 'run.failed' | 'run.cancelled',
      runId: string,
    ): void => {
      const sessionId = runSessionsRef.current[runId]
      if (sessionId === undefined) return
      const nextCount = Math.max(
        0,
        (activeSessionRunsRef.current[sessionId] ?? 1) - 1,
      )
      if (nextCount === 0) delete activeSessionRunsRef.current[sessionId]
      else activeSessionRunsRef.current[sessionId] = nextCount
      setRunningSessionIds(Object.keys(activeSessionRunsRef.current))
      if (status === 'run.completed') {
        // 完成标记持久保留，点击会话行（clearSessionStatus）后清除。
        setCompletedSessionIds((ids) =>
          ids.includes(sessionId) ? ids : [...ids, sessionId],
        )
      } else if (status === 'run.failed') {
        // 失败信息由时间线失败卡 + 重试按钮完整呈现，不重复弹全局 notice。
        setFailedSessionIds((ids) =>
          ids.includes(sessionId) ? ids : [...ids, sessionId],
        )
      }
      // run.cancelled：用户主动停止，只递减运行计数，不打标记。
      delete runSessionsRef.current[runId]
    },
    [],
  )

  const clearSessionStatus = useCallback((sessionId: string): void => {
    setCompletedSessionIds((ids) => ids.filter((id) => id !== sessionId))
    setFailedSessionIds((ids) => ids.filter((id) => id !== sessionId))
  }, [])

  return {
    runningSessionIds,
    completedSessionIds,
    failedSessionIds,
    onRunStarted,
    onRunSettled,
    clearSessionStatus,
  }
}
