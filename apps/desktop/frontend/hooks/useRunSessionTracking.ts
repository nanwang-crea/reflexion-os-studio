import { useCallback, useRef, useState } from 'react'

/**
 * 会话级 Run 状态跟踪：运行中计数、最近完成闪烁（1.6s 自动消退）、失败标记。
 * 由 bootstrap 事件回调驱动（run.started / run.completed / run.failed）。
 */
export function useRunSessionTracking(): {
  runningSessionIds: string[]
  completedSessionIds: string[]
  failedSessionIds: string[]
  onRunStarted: (runId: string, sessionId: string) => void
  onRunSettled: (status: 'run.completed' | 'run.failed', runId: string) => void
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
  }, [])

  const onRunSettled = useCallback(
    (status: 'run.completed' | 'run.failed', runId: string): void => {
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
        setCompletedSessionIds((ids) =>
          ids.includes(sessionId) ? ids : [...ids, sessionId],
        )
        window.setTimeout(() => {
          setCompletedSessionIds((ids) => ids.filter((id) => id !== sessionId))
        }, 1600)
      } else {
        // 失败信息由时间线失败卡 + 重试按钮完整呈现，不重复弹全局 notice。
        setFailedSessionIds((ids) =>
          ids.includes(sessionId) ? ids : [...ids, sessionId],
        )
      }
      delete runSessionsRef.current[runId]
    },
    [],
  )

  return {
    runningSessionIds,
    completedSessionIds,
    failedSessionIds,
    onRunStarted,
    onRunSettled,
  }
}
