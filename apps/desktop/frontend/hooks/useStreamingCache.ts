import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 流式 delta 缓存（正文 + 思考）：16ms 防抖合帧刷新；messageId → runId
 * 归属表支撑 Run 结束后的按范围修剪。
 */
export function useStreamingCache(): {
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  applyDelta: (messageId: string, runId: string, delta: string) => void
  applyReasoningDelta: (messageId: string, runId: string, delta: string) => void
  /** message.reset：清空该消息的流式缓存（重试会重置草稿）。 */
  applyReset: (messageId: string) => void
  /** message.completed：最终正文先落缓存占位，等刷新落地后再修剪，避免闪空。 */
  applyCompleted: (messageId: string, runId: string, content: string) => void
  reset: () => void
  /**
   * Run 结束后的缓存修剪：同步收集本次范围涉及的键并返回闭包，
   * 会话数据刷新落地后再执行删除；只删收集时已存在且仍归属该范围的键，
   * 不会误伤期间新启动 Run 的 delta。
   */
  collectStalePrune: (runId: string, messageId?: string) => () => void
} {
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  const streamingRef = useRef<Record<string, string>>({})
  const [streamingReasoning, setStreamingReasoning] = useState<
    Record<string, string>
  >({})
  const streamingReasoningRef = useRef<Record<string, string>>({})
  const streamRunRef = useRef<Record<string, string>>({})
  const streamingFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const streamingFlushPending = useRef(false)

  const flushStreaming = useCallback((): void => {
    streamingFlushTimer.current = null
    if (!streamingFlushPending.current) return
    streamingFlushPending.current = false
    setStreaming({ ...streamingRef.current })
    setStreamingReasoning({ ...streamingReasoningRef.current })
  }, [])

  const scheduleStreamingFlush = useCallback((): void => {
    streamingFlushPending.current = true
    if (streamingFlushTimer.current !== null) return
    streamingFlushTimer.current = setTimeout(flushStreaming, 16)
  }, [flushStreaming])

  // 卸载时清理挂起的合帧定时器，避免卸载后 setState。
  useEffect(
    () => () => {
      if (streamingFlushTimer.current !== null) {
        clearTimeout(streamingFlushTimer.current)
        streamingFlushTimer.current = null
      }
      streamingFlushPending.current = false
    },
    [],
  )

  const applyDelta = useCallback(
    (messageId: string, runId: string, delta: string): void => {
      streamRunRef.current[messageId] = runId
      streamingRef.current = {
        ...streamingRef.current,
        [messageId]: (streamingRef.current[messageId] ?? '') + delta,
      }
      scheduleStreamingFlush()
    },
    [scheduleStreamingFlush],
  )

  const applyReasoningDelta = useCallback(
    (messageId: string, runId: string, delta: string): void => {
      streamRunRef.current[messageId] = runId
      streamingReasoningRef.current = {
        ...streamingReasoningRef.current,
        [messageId]: (streamingReasoningRef.current[messageId] ?? '') + delta,
      }
      scheduleStreamingFlush()
    },
    [scheduleStreamingFlush],
  )

  const applyReset = useCallback((messageId: string): void => {
    delete streamingRef.current[messageId]
    delete streamingReasoningRef.current[messageId]
    setStreaming({ ...streamingRef.current })
    setStreamingReasoning({ ...streamingReasoningRef.current })
  }, [])

  const applyCompleted = useCallback(
    (messageId: string, runId: string, content: string): void => {
      streamRunRef.current[messageId] = runId
      streamingRef.current = {
        ...streamingRef.current,
        [messageId]: content,
      }
      scheduleStreamingFlush()
    },
    [scheduleStreamingFlush],
  )

  const reset = useCallback((): void => {
    streamingRef.current = {}
    setStreaming({})
    streamingReasoningRef.current = {}
    setStreamingReasoning({})
    streamRunRef.current = {}
    if (streamingFlushTimer.current !== null) {
      clearTimeout(streamingFlushTimer.current)
      streamingFlushTimer.current = null
    }
    streamingFlushPending.current = false
  }, [])

  const collectStalePrune = useCallback(
    (runId: string, messageId?: string): (() => void) => {
      const belongsToScope = (id: string): boolean =>
        messageId !== undefined
          ? id === messageId
          : streamRunRef.current[id] === runId
      const staleContent = Object.keys(streamingRef.current).filter(
        belongsToScope,
      )
      const staleReasoning = Object.keys(streamingReasoningRef.current).filter(
        belongsToScope,
      )
      return () => {
        let contentChanged = false
        for (const id of staleContent) {
          if (id in streamingRef.current && belongsToScope(id)) {
            delete streamingRef.current[id]
            delete streamRunRef.current[id]
            contentChanged = true
          }
        }
        let reasoningChanged = false
        for (const id of staleReasoning) {
          if (id in streamingReasoningRef.current && belongsToScope(id)) {
            delete streamingReasoningRef.current[id]
            delete streamRunRef.current[id]
            reasoningChanged = true
          }
        }
        if (contentChanged) setStreaming({ ...streamingRef.current })
        if (reasoningChanged)
          setStreamingReasoning({ ...streamingReasoningRef.current })
      }
    },
    [],
  )

  return {
    streaming,
    streamingReasoning,
    applyDelta,
    applyReasoningDelta,
    applyReset,
    applyCompleted,
    reset,
    collectStalePrune,
  }
}
