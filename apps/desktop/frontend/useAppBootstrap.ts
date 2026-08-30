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
 * 流式 delta 缓存、启动期初始数据拉取（失败降级为通知并自动重试一次）。
 */
export function useAppBootstrap(deps: AppBootstrapDeps): {
  bootstrap: BootstrapSnapshot | null
  streaming: Record<string, string>
  resetStreaming: () => void
} {
  const [bootstrap, setBootstrap] = useState<BootstrapSnapshot | null>(null)
  const [streaming, setStreaming] = useState<Record<string, string>>({})
  const streamingRef = useRef<Record<string, string>>({})

  const fail = useCallback(
    (error: unknown): void => {
      deps.setNotice(error instanceof Error ? error.message : String(error))
    },
    [deps],
  )

  const resetStreaming = useCallback((): void => {
    streamingRef.current = {}
    setStreaming({})
  }, [])

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
          const next = {
            ...streamingRef.current,
            [event.messageId]:
              (streamingRef.current[event.messageId] ?? '') + event.delta,
          }
          streamingRef.current = next
          setStreaming(next)
          return
        }
        if (EVENT_TYPES_TRIGGERING_REFRESH.has(event.type)) {
          streamingRef.current = {}
          setStreaming({})
          // Provider/网络等失败原因必须可见：直接进顶部通知条。
          if (event.type === 'run.failed') {
            fail(new Error(event.error.message))
          }
          // Run 结束后标题可能已被自动命名，会话列表一并刷新。
          const sessionId = deps.activeSessionRef.current
          if (sessionId) void deps.refreshSessionData(sessionId)
          void deps.refreshStandaloneSessions()
          const projectId = deps.activeProjectRef.current
          if (projectId) void deps.refreshProjectSessions(projectId)
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
  }, [deps, fail, loadInitialData])

  return { bootstrap, streaming, resetStreaming }
}
