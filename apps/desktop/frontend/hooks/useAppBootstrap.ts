import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { RefObject } from 'react'
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'
import { transport } from '../lib/transport'
import { useInitialDataLoad } from './useInitialDataLoad'
import type { RunActivity } from './useRunActivity'
import { useRunActivity } from './useRunActivity'
import {
  usePendingApprovals,
  type PendingApproval,
} from './usePendingApprovals'
import { useRunSessionTracking } from './useRunSessionTracking'
import { useStreamingCache } from './useStreamingCache'

export interface BootstrapSnapshot {
  state: string
  runtimeReady: boolean
  systemReady: boolean
  detail?: string
}

export type { PendingApproval }

/** Run 结束类事件：触发会话数据与列表刷新（标题可能已被自动命名）。 */
const EVENT_TYPES_TRIGGERING_REFRESH = new Set([
  'message.completed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'plan.created',
  'plan.step.updated',
  'plan.updated',
])

interface AppBootstrapDeps {
  activeSessionRef: RefObject<string | null>
  activeProjectRef: RefObject<string | null>
  refreshProfiles: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshSessionData: (sessionId: string) => Promise<void>
  refreshStandaloneSessions: () => Promise<void>
  refreshProjectSessions: (projectId: string) => Promise<void>
  refreshDelegations: (sessionId: string) => Promise<void>
  setNotice: (notice: string | null) => void
}

/**
 * 应用引导与 Runtime 接线：宿主状态快照、sidecar 事件订阅、
 * Run 级活动阶段与审批等待；流式缓存与启动拉取拆分在专属 hook。
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
  runningSessionIds: string[]
  completedSessionIds: string[]
  failedSessionIds: string[]
  /** 有待审批工具调用的会话（侧栏 ✋ 标记）。 */
  approvalSessionIds: string[]
  /** 点击会话行视为确认：清除该会话的完成/失败标记。 */
  clearSessionStatus: (sessionId: string) => void
  retryTick: number
} {
  const { bootstrap, setBootstrap } = useBootstrapSnapshot()
  const cache = useStreamingCache()
  const activity = useRunActivity()
  const loadInitialData = useInitialDataLoad({
    refreshProfiles: deps.refreshProfiles,
    refreshProjects: deps.refreshProjects,
    refreshStandaloneSessions: deps.refreshStandaloneSessions,
    setNotice: deps.setNotice,
  })
  const approvals = usePendingApprovals()
  const sessionTracking = useRunSessionTracking()

  // A2 Memory：非打断式写入提示（顶栏角标，自动消失），不用弹窗。
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null)
  const memoryNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showMemoryNotice = useCallback((text: string): void => {
    if (memoryNoticeTimer.current) clearTimeout(memoryNoticeTimer.current)
    setMemoryNotice(text)
    memoryNoticeTimer.current = setTimeout(() => {
      memoryNoticeTimer.current = null
      setMemoryNotice(null)
    }, 6000)
  }, [])
  // 工具事件触发的防抖刷新：Run 进行中让轨迹卡状态跟进，不必等 Run 结束。
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

  // 委派事件防抖刷新：task 子 Run 创建/状态推进时让委派树实时跟进。
  const delegationRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const scheduleDelegationRefresh = useCallback(
    (sessionId?: string): void => {
      const target = sessionId ?? deps.activeSessionRef.current
      if (target === null) return
      if (delegationRefreshTimer.current)
        clearTimeout(delegationRefreshTimer.current)
      delegationRefreshTimer.current = setTimeout(() => {
        delegationRefreshTimer.current = null
        void deps.refreshDelegations(target).catch(() => undefined)
      }, 200)
    },
    [deps],
  )

  /** 会话切换/重置：清空流式缓存与全部 Run 活动状态。 */
  const resetStreaming = useCallback((): void => {
    cache.reset()
    activity.clearAllRunActivities()
  }, [cache, activity])

  /**
   * Run 结束后的会话数据刷新 + 流式缓存清理。
   * 正文/思考的最终值在刷新落地前继续留在缓存里（message.completed 事件
   * 会先把最终正文写入缓存），避免刷新落地前消息闪空；刷新完成后仅移除
   * 刷新开始时已存在的键，不会误伤期间新启动 Run 的 delta。
   */
  const refreshAndPrune = useCallback(
    (runId: string, messageId?: string): void => {
      const prune = cache.collectStalePrune(runId, messageId)
      const sessionId = deps.activeSessionRef.current
      const refresh =
        sessionId !== null
          ? deps.refreshSessionData(sessionId).catch(() => undefined)
          : Promise.resolve()
      void refresh.finally(() => {
        if (messageId === undefined) activity.clearRunActivity(runId)
        prune()
      })
    },
    [deps, cache, activity],
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
        if (event.type === 'message.reset') {
          cache.applyReset(event.messageId)
          return
        }
        if (event.type === 'message.delta') {
          activity.setRunActivity(event.runId, { phase: 'answering' })
          cache.applyDelta(event.messageId, event.runId, event.delta)
          return
        }
        if (event.type === 'message.reasoning_delta') {
          activity.setRunActivity(event.runId, { phase: 'thinking' })
          cache.applyReasoningDelta(event.messageId, event.runId, event.delta)
          return
        }
        if (event.type === 'run.started') {
          activity.setRunActivity(event.runId, { phase: 'thinking' })
          sessionTracking.onRunStarted(event.runId, event.run.sessionId)
          // Runtime 侧自动出队（队列 pump / sendNow）产生的新消息不经前端
          // 发送路径，补一次刷新让消息列表即时跟上；仅限当前查看的会话，
          // 避免后台会话的 run 覆盖当前页数据。
          if (event.run.sessionId === deps.activeSessionRef.current) {
            void deps
              .refreshSessionData(event.run.sessionId)
              .catch(() => undefined)
          }
          return
        }
        if (event.type === 'run.retrying') {
          // 重试不走全局 notice：活倒计时内联在 RunBlock 标签上，
          // 恢复后由后续事件整体覆盖 retry 字段自动消失。
          activity.setRunActivity(event.runId, {
            phase: 'thinking',
            retry: {
              attempt: event.attempt,
              maxRetries: event.maxRetries,
              reason: event.reason,
              ...(event.waitMs !== undefined
                ? { waitMs: event.waitMs, startedAt: Date.now() }
                : {}),
            },
          })
          return
        }
        if (event.type === 'tool.requested') {
          activity.setRunActivity(event.runId, {
            phase: 'tool',
            toolName: event.toolName,
          })
          scheduleToolRefresh()
          return
        }
        if (event.type === 'approval.required') {
          approvals.onApprovalRequired({
            toolCallId: event.toolCallId,
            runId: event.runId,
            ...(event.sessionId !== undefined
              ? { sessionId: event.sessionId }
              : {}),
            operation: event.operation,
            summary: event.summary,
          })
          return
        }
        if (event.type === 'approval.resolved') {
          approvals.onApprovalResolved(event.toolCallId)
          return
        }
        if (
          event.type === 'run.completed' ||
          event.type === 'run.failed' ||
          event.type === 'run.cancelled'
        ) {
          // 三种终态都结算侧边栏运行计数；cancelled 只递减，不闪完成/失败标。
          sessionTracking.onRunSettled(event.type, event.runId)
          // 继续进入统一刷新路径，确保失败/取消时持久化的消息状态及时落到前端。
        }
        // 委派事件：更新当前会话对应的委派树（task 子 Run 创建/状态推进）。
        if (
          event.type === 'delegation.created' ||
          event.type === 'delegation.updated'
        ) {
          scheduleDelegationRefresh(event.delegation.sessionId)
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
            cache.applyCompleted(event.messageId, event.runId, event.content)
          }
          // run.failed 已在上方完成状态更新；这里仅负责刷新会话数据。
          // Run 结束后标题可能已被自动命名，会话列表一并刷新。
          void deps.refreshStandaloneSessions()
          const projectId = deps.activeProjectRef.current
          if (projectId) void deps.refreshProjectSessions(projectId)
          approvals.clearForRun(event.runId)
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
      loadInitialData()
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
      if (delegationRefreshTimer.current)
        clearTimeout(delegationRefreshTimer.current)
      unlistenState?.()
      unlistenEvents?.()
    }
  }, [
    deps,
    cache,
    activity,
    loadInitialData,
    refreshAndPrune,
    approvals,
    sessionTracking,
    scheduleToolRefresh,
    scheduleDelegationRefresh,
    showMemoryNotice,
    setBootstrap,
  ])

  return {
    bootstrap,
    streaming: cache.streaming,
    streamingReasoning: cache.streamingReasoning,
    runActivities: activity.runActivities,
    resetStreaming,
    pendingApprovals: approvals.pendingApprovals,
    clearPendingApprovals: approvals.clearForRun,
    memoryNotice,
    runningSessionIds: sessionTracking.runningSessionIds,
    completedSessionIds: sessionTracking.completedSessionIds,
    failedSessionIds: sessionTracking.failedSessionIds,
    approvalSessionIds: useMemo(
      () =>
        [
          ...new Set(
            approvals.pendingApprovals
              .map((entry) => entry.sessionId)
              .filter((id): id is string => id !== undefined),
          ),
        ].sort(),
      [approvals.pendingApprovals],
    ),
    clearSessionStatus: sessionTracking.clearSessionStatus,
    retryTick: activity.retryTick,
  }
}

/** 宿主引导状态快照：bootstrap:state 事件 + 初始 invoke 双通道。 */
function useBootstrapSnapshot(): {
  bootstrap: BootstrapSnapshot | null
  setBootstrap: (snapshot: BootstrapSnapshot | null) => void
} {
  const [bootstrap, setBootstrap] = useState<BootstrapSnapshot | null>(null)
  return { bootstrap, setBootstrap }
}
