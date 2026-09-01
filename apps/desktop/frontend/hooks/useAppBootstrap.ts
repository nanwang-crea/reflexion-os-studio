import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { RefObject } from 'react'
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'
import { transport } from '../lib/transport'

export interface BootstrapSnapshot {
  state: string
  runtimeReady: boolean
  systemReady: boolean
  detail?: string
}

/** 等待用户审批的工具调用（approval.required → approval.resolved 之间可见）。 */
export interface PendingApproval {
  toolCallId: string
  runId: string
  operation: string
  summary: string
}

/** Run 级活动阶段：由事件驱动，对齐 Codex——不靠“内容长什么样”猜状态。 */
export type RunPhase = 'thinking' | 'answering' | 'tool'
export interface RunActivity {
  phase: RunPhase
  /** phase === 'tool' 时正在执行的工具名。 */
  toolName?: string
  /** 当前正在进行的 Provider 重试。 */
  retry?: { attempt: number; maxRetries: number; reason: string }
}

/** Run 结束类事件：触发会话数据与列表刷新（标题可能已被自动命名）。 */
const EVENT_TYPES_TRIGGERING_REFRESH = new Set([
  'message.completed',
  'run.completed',
  'run.failed',
  'run.cancelled',
])

interface AppBootstrapDeps {
  activeSessionRef: RefObject<string | null>
  activeProjectRef: RefObject<string | null>
  refreshProfiles: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshSessionData: (sessionId: string) => Promise<void>
  refreshStandaloneSessions: () => Promise<void>
  refreshProjectSessions: (projectId: string) => Promise<void>
  setNotice: (notice: string | null) => void
}

/**
 * 应用引导与 Runtime 接线：宿主状态快照、sidecar 事件订阅、
 * 流式 delta 缓存（正文 + 思考）、启动期初始数据拉取（失败降级为通知并自动重试一次）。
 */
export function useAppBootstrap(deps: AppBootstrapDeps): {
  bootstrap: BootstrapSnapshot | null
  streaming: Record<string, string>
  streamingReasoning: Record<string, string>
  runActivities: Record<string, RunActivity>
  resetStreaming: () => void
  pendingApprovals: PendingApproval[]
  clearPendingApprovals: (runId: string) => void
  memoryNotice: string | null
} {
  const [bootstrap, setBootstrap] = useState<BootstrapSnapshot | null>(null)
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
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  )
  // A2 Memory：非打断式写入提示（顶栏角标，自动消失），不用弹窗。
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null)
  const memoryNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showMemoryNotice = useCallback((text: string): void => {
    if (memoryNoticeTimer.current) clearTimeout(memoryNoticeTimer.current)
    setMemoryNotice(text)
    memoryNoticeTimer.current = setTimeout(() => {
      memoryNoticeTimer.current = null
      setMemoryNotice(null)
    }, 6000)
  }, [])
  // 工具事件触发的防抖刷新：Run 进行中让轨迹卡状态跟进，不必等 Run 结束。
  const toolRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleToolRefresh = useCallback((): void => {
    if (toolRefreshTimer.current) clearTimeout(toolRefreshTimer.current)
    toolRefreshTimer.current = setTimeout(() => {
      toolRefreshTimer.current = null
      const sessionId = deps.activeSessionRef.current
      if (sessionId !== null) {
        void deps.refreshSessionData(sessionId).catch(() => undefined)
      }
    }, 200)
  }, [deps])

  const fail = useCallback(
    (error: unknown): void => {
      deps.setNotice(error instanceof Error ? error.message : String(error))
    },
    [deps],
  )

  // Run 级活动阶段（对齐 Codex）：由事件驱动，终态才清除（锁存）。
  // 用 ref 承载当前值，避免事件回调里的闭包读到过期 state。
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

  const resetStreaming = useCallback((): void => {
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
    runActivitiesRef.current = {}
    setRunActivities({})
  }, [])

  /** Run 终态时清理该 Run 遗留的审批等待（取消/失败路径的兜底）。 */
  const clearPendingApprovals = useCallback((runId: string): void => {
    setPendingApprovals((pending) =>
      pending.filter((entry) => entry.runId !== runId),
    )
  }, [])

  /**
   * Run 结束后的会话数据刷新 + 流式缓存清理。
   * 正文/思考的最终值在刷新落地前继续留在缓存里（message.completed 事件
   * 会先把最终正文写入缓存），避免刷新落地前消息闪空；刷新完成后仅移除
   * 刷新开始时已存在的键，不会误伤期间新启动 Run 的 delta。
   */
  const refreshAndPrune = useCallback(
    (runId: string, messageId?: string): void => {
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
      const sessionId = deps.activeSessionRef.current
      const refresh =
        sessionId !== null
          ? deps.refreshSessionData(sessionId).catch(() => undefined)
          : Promise.resolve()
      void refresh.finally(() => {
        if (messageId === undefined) clearRunActivity(runId)
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
      })
    },
    [deps, clearRunActivity],
  )

  /** 启动期初始数据：并行拉取，失败自动重试一次后降级为通知（非致命）。 */
  const loadInitialData = useCallback(
    async (retry = true): Promise<void> => {
      const fetchAll = () =>
        Promise.allSettled([
          deps.refreshProfiles(),
          deps.refreshProjects(),
          deps.refreshStandaloneSessions(),
        ])
      const findFailure = (
        settled: PromiseSettledResult<void>[],
      ): PromiseRejectedResult | undefined =>
        settled.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        )
      let failure = findFailure(await fetchAll())
      if (failure && retry) {
        // sidecar 就绪竞态等瞬时错误：稍等后自动重试一次
        await new Promise<void>((resolve) => {
          initialRetryTimer.current = setTimeout(() => {
            initialRetryTimer.current = null
            resolve()
          }, 2000)
        })
        failure = findFailure(await fetchAll())
      }
      if (failure) fail(failure.reason)
    },
    [deps, fail],
  )

  useEffect(() => {
    let unlistenState: (() => void) | undefined
    let unlistenEvents: (() => void) | undefined
    let disposed = false

    const start = async (): Promise<void> => {
      await transport.attach()
      if (disposed) return
      unlistenEvents = transport.onEvent((event: RuntimeEvent) => {
        if (disposed) return
        if (event.type === 'message.delta') {
          setRunActivity(event.runId, { phase: 'answering' })
          streamRunRef.current[event.messageId] = event.runId
          streamingRef.current = {
            ...streamingRef.current,
            [event.messageId]:
              (streamingRef.current[event.messageId] ?? '') + event.delta,
          }
          scheduleStreamingFlush()
          return
        }
        if (event.type === 'message.reasoning_delta') {
          setRunActivity(event.runId, { phase: 'thinking' })
          streamRunRef.current[event.messageId] = event.runId
          streamingReasoningRef.current = {
            ...streamingReasoningRef.current,
            [event.messageId]:
              (streamingReasoningRef.current[event.messageId] ?? '') +
              event.delta,
          }
          scheduleStreamingFlush()
          return
        }
        if (event.type === 'run.started') {
          setRunActivity(event.runId, { phase: 'thinking' })
          return
        }
        if (event.type === 'run.retrying') {
          setRunActivity(event.runId, {
            phase: 'thinking',
            retry: {
              attempt: event.attempt,
              maxRetries: event.maxRetries,
              reason: event.reason,
            },
          })
          return
        }
        if (event.type === 'tool.requested') {
          setRunActivity(event.runId, {
            phase: 'tool',
            toolName: event.toolName,
          })
          scheduleToolRefresh()
          return
        }
        if (event.type === 'approval.required') {
          setPendingApprovals((pending) => [
            ...pending.filter((entry) => entry.toolCallId !== event.toolCallId),
            {
              toolCallId: event.toolCallId,
              runId: event.runId,
              operation: event.operation,
              summary: event.summary,
            },
          ])
          return
        }
        if (event.type === 'approval.resolved') {
          setPendingApprovals((pending) =>
            pending.filter((entry) => entry.toolCallId !== event.toolCallId),
          )
          return
        }
        // 工具调用事件：防抖刷新当前会话，轨迹卡在 Run 进行中也能推进状态。
        if (event.type === 'tool.completed') {
          scheduleToolRefresh()
          return
        }
        // 记忆写入事件：轻提示，不打断对话；同时刷新会话数据无需做（记忆不进消息流）。
        if (event.type === 'memory.written') {
          if (event.memories.length > 0) {
            showMemoryNotice(`已记住 ${event.memories.length} 条新信息`)
          }
          return
        }
        if (EVENT_TYPES_TRIGGERING_REFRESH.has(event.type)) {
          if (event.type === 'message.completed') {
            // 最终正文先落缓存占位，等刷新落地后再由 prune 清理，避免闪空。
            streamRunRef.current[event.messageId] = event.runId
            streamingRef.current = {
              ...streamingRef.current,
              [event.messageId]: event.content,
            }
            scheduleStreamingFlush()
          }
          // Provider/网络等失败原因必须可见：直接进顶部通知条。
          if (event.type === 'run.failed') {
            fail(new Error(event.error.message))
          }
          // Run 结束后标题可能已被自动命名，会话列表一并刷新。
          void deps.refreshStandaloneSessions()
          const projectId = deps.activeProjectRef.current
          if (projectId) void deps.refreshProjectSessions(projectId)
          clearPendingApprovals(event.runId)
          refreshAndPrune(
            event.runId,
            event.type === 'message.completed' ? event.messageId : undefined,
          )
        }
      })
      unlistenState = await listen<BootstrapSnapshot>(
        'bootstrap:state',
        (event) => {
          if (!disposed) setBootstrap(event.payload)
        },
      )
      if (disposed) {
        unlistenState()
        unlistenEvents?.()
        return
      }
      const snapshot = await invoke<BootstrapSnapshot>('bootstrap_get_state')
      if (disposed) return
      setBootstrap(snapshot)
      // 启动期数据拉取不属于引导本身：失败只降级为通知并自动重试一次，
      // 不把整个应用打成启动失败（sidecar 就绪竞态、瞬时错误都能自愈）。
      void loadInitialData()
    }

    void start().catch((error: unknown) => {
      if (disposed) return
      setBootstrap({
        state: 'error',
        runtimeReady: false,
        systemReady: false,
        detail: String(error),
      })
    })

    return () => {
      disposed = true
      if (toolRefreshTimer.current) clearTimeout(toolRefreshTimer.current)
      if (memoryNoticeTimer.current) clearTimeout(memoryNoticeTimer.current)
      if (streamingFlushTimer.current) {
        clearTimeout(streamingFlushTimer.current)
        streamingFlushTimer.current = null
      }
      streamingFlushPending.current = false
      if (initialRetryTimer.current) {
        clearTimeout(initialRetryTimer.current)
        initialRetryTimer.current = null
      }
      unlistenState?.()
      unlistenEvents?.()
    }
  }, [
    deps,
    fail,
    loadInitialData,
    refreshAndPrune,
    clearPendingApprovals,
    clearRunActivity,
    scheduleToolRefresh,
    scheduleStreamingFlush,
    setRunActivity,
    showMemoryNotice,
  ])

  return {
    bootstrap,
    streaming,
    streamingReasoning,
    runActivities,
    resetStreaming,
    pendingApprovals,
    clearPendingApprovals,
    memoryNotice,
  }
}
