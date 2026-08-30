import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { RefObject } from 'react'
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'
import { transport } from './transport'

export interface BootstrapSnapshot {
  state: string
  runtimeReady: boolean
  systemReady: boolean
  detail?: string
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
  resetStreaming: () => void
} {
  const [bootstrap, setBootstrap] = useState<BootstrapSnapshot | null>(null)
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  const streamingRef = useRef<Record<string, string>>({})
  const [streamingReasoning, setStreamingReasoning] = useState<
    Record<string, string>
  >({})
  const streamingReasoningRef = useRef<Record<string, string>>({})

  const fail = useCallback(
    (error: unknown): void => {
      deps.setNotice(error instanceof Error ? error.message : String(error))
    },
    [deps],
  )

  const resetStreaming = useCallback((): void => {
    streamingRef.current = {}
    setStreaming({})
    streamingReasoningRef.current = {}
    setStreamingReasoning({})
  }, [])

  /**
   * Run 结束后的会话数据刷新 + 流式缓存清理。
   * 正文/思考的最终值在刷新落地前继续留在缓存里（message.completed 事件
   * 会先把最终正文写入缓存），避免刷新落地前消息闪空；刷新完成后仅移除
   * 刷新开始时已存在的键，不会误伤期间新启动 Run 的 delta。
   */
  const refreshAndPrune = useCallback((): void => {
    const staleContent = Object.keys(streamingRef.current)
    const staleReasoning = Object.keys(streamingReasoningRef.current)
    const sessionId = deps.activeSessionRef.current
    const refresh =
      sessionId !== null
        ? deps.refreshSessionData(sessionId).catch(() => undefined)
        : Promise.resolve()
    void refresh.finally(() => {
      if (staleContent.length === 0 && staleReasoning.length === 0) return
      let contentChanged = false
      for (const id of staleContent) {
        if (id in streamingRef.current) {
          delete streamingRef.current[id]
          contentChanged = true
        }
      }
      let reasoningChanged = false
      for (const id of staleReasoning) {
        if (id in streamingReasoningRef.current) {
          delete streamingReasoningRef.current[id]
          reasoningChanged = true
        }
      }
      if (contentChanged) setStreaming({ ...streamingRef.current })
      if (reasoningChanged)
        setStreamingReasoning({ ...streamingReasoningRef.current })
    })
  }, [deps])

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
        await new Promise((resolve) => setTimeout(resolve, 2000))
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
      unlistenEvents = transport.onEvent((event: RuntimeEvent) => {
        if (event.type === 'message.delta') {
          streamingRef.current = {
            ...streamingRef.current,
            [event.messageId]:
              (streamingRef.current[event.messageId] ?? '') + event.delta,
          }
          setStreaming(streamingRef.current)
          return
        }
        if (event.type === 'message.reasoning_delta') {
          streamingReasoningRef.current = {
            ...streamingReasoningRef.current,
            [event.messageId]:
              (streamingReasoningRef.current[event.messageId] ?? '') +
              event.delta,
          }
          setStreamingReasoning(streamingReasoningRef.current)
          return
        }
        if (EVENT_TYPES_TRIGGERING_REFRESH.has(event.type)) {
          if (event.type === 'message.completed') {
            // 最终正文先落缓存占位，等刷新落地后再由 prune 清理，避免闪空。
            streamingRef.current = {
              ...streamingRef.current,
              [event.messageId]: event.content,
            }
            setStreaming(streamingRef.current)
          }
          // Provider/网络等失败原因必须可见：直接进顶部通知条。
          if (event.type === 'run.failed') {
            fail(new Error(event.error.message))
          }
          // Run 结束后标题可能已被自动命名，会话列表一并刷新。
          void deps.refreshStandaloneSessions()
          const projectId = deps.activeProjectRef.current
          if (projectId) void deps.refreshProjectSessions(projectId)
          refreshAndPrune()
        }
      })
      unlistenState = await listen<BootstrapSnapshot>(
        'bootstrap:state',
        (event) => {
          if (!disposed) setBootstrap(event.payload)
        },
      )
      if (disposed) return
      setBootstrap(await invoke<BootstrapSnapshot>('bootstrap_get_state'))
      // 启动期数据拉取不属于引导本身：失败只降级为通知并自动重试一次，
      // 不把整个应用打成启动失败（sidecar 就绪竞态、瞬时错误都能自愈）。
      void loadInitialData()
    }

    void start().catch((error: unknown) => {
      setBootstrap({
        state: 'error',
        runtimeReady: false,
        systemReady: false,
        detail: String(error),
      })
    })

    return () => {
      disposed = true
      unlistenState?.()
      unlistenEvents?.()
    }
  }, [deps, fail, loadInitialData, refreshAndPrune])

  return { bootstrap, streaming, streamingReasoning, resetStreaming }
}
