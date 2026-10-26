import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DangerAccessLease,
  HistoryCursor,
  RuntimeEvent,
} from '@reflexion-os-studio/runtime-client'
import type { PendingApproval } from '../../hooks/permissions/usePendingApprovals'
import type { PendingInteraction } from '../../hooks/interactions/usePendingInteractions'
import { useStreamingCache } from '../../hooks/session/useStreamingCache'
import { useRunActivity } from '../../hooks/session/useRunActivity'
import {
  mergeLatestHistory,
  prependHistory,
} from '../../hooks/session/history-pages'
import { getSessionData, type SessionData } from '../../api/sessions'
import { listDelegations } from '../../api/agents'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { getRemoteTransport } from '../../lib/transport'

export function useRemoteSession(sessionId: string) {
  const [dangerLease, setDangerLease] = useState<DangerAccessLease | null>(null)
  const [data, setData] = useState<SessionData | null>(null)
  const [delegations, setDelegations] = useState<Delegation[]>([])
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [interactions, setInteractions] = useState<PendingInteraction[]>([])
  const [connection, setConnection] = useState('正在连接电脑…')
  const [notice, setNotice] = useState<string | null>(null)
  const cache = useStreamingCache()
  const activity = useRunActivity()
  const generation = useRef(0)
  const readSequence = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const epoch = generation.current
    const sequence = ++readSequence.current
    const [next, children] = await Promise.all([
      getSessionData(sessionId),
      listDelegations(sessionId),
    ])
    if (generation.current !== epoch || sequence !== readSequence.current)
      return
    setData((current) => mergeLatestHistory(current, next))
    setDelegations(children)
  }, [sessionId])
  const latest = useRef({ cache, activity, refresh })
  latest.current = { cache, activity, refresh }
  useEffect(() => {
    const epoch = generation
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        void latest.current.refresh().catch(() => {
          if (!disposed) setNotice('读取会话失败，请检查连接')
        })
      }, 150)
    }
    const apply = (event: RuntimeEvent): void => {
      const { cache: stream, activity: runActivity } = latest.current
      if (event.type === 'message.delta') {
        stream.applyDelta(event.messageId, event.runId, event.delta)
        runActivity.setRunActivity(event.runId, { phase: 'answering' })
        return
      }
      if (event.type === 'message.reasoning_delta') {
        stream.applyReasoningDelta(event.messageId, event.runId, event.delta)
        runActivity.setRunActivity(event.runId, { phase: 'thinking' })
        return
      }
      if (event.type === 'danger.changed') setDangerLease(event.lease)
      if (event.type === 'message.reset') stream.applyReset(event.messageId)
      if (event.type === 'message.completed')
        stream.applyCompleted(event.messageId, event.runId, event.content)
      if (event.type === 'run.model_activity')
        runActivity.setRunActivity(event.runId, {
          phase: event.phase,
          toolName: event.toolName,
          taskName: event.taskName,
        })
      if (event.type === 'approval.required')
        setApprovals((current) => [
          ...current.filter((item) => item.toolCallId !== event.toolCallId),
          event,
        ])
      if (event.type === 'approval.resolved')
        setApprovals((current) =>
          current.filter((item) => item.toolCallId !== event.toolCallId),
        )
      if (event.type === 'interaction.required')
        setInteractions((current) => [
          ...current.filter(
            (item) => item.interactionId !== event.interactionId,
          ),
          event,
        ])
      if (event.type === 'interaction.resolved')
        setInteractions((current) =>
          current.filter((item) => item.interactionId !== event.interactionId),
        )
      if (
        event.scope === 'run' &&
        ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)
      ) {
        runActivity.clearRunActivity(event.runId)
        setApprovals((current) =>
          current.filter((item) => item.runId !== event.runId),
        )
        setInteractions((current) =>
          current.filter((item) => item.runId !== event.runId),
        )
        const prune = stream.collectStalePrune(event.runId)
        void latest.current
          .refresh()
          .then(() => {
            if (!disposed) prune()
          })
          .catch(() => {})
      }
      schedule()
    }
    const close = getRemoteTransport().stream(
      (packet) => {
        if (disposed) return
        if (packet.type === 'snapshot') {
          epoch.current++
          readSequence.current++
          setData((current) => mergeLatestHistory(current, packet.history))
          setDangerLease(packet.dangerLease)
          setApprovals([])
          setInteractions([])
          latest.current.cache.reset()
          latest.current.activity.clearAllRunActivities()
          if (packet.incomplete)
            setNotice('运行中的内容超过恢复缓存上限，请等待完整回复落库后查看')
          for (const event of packet.events) apply(event)
          schedule()
        } else apply(packet.event)
      },
      (state) => {
        if (!disposed)
          setConnection(
            state === 'connected'
              ? '已连接电脑'
              : state === 'closed'
                ? '设备授权已失效或连接无法恢复，请重新扫码'
                : '连接中断，正在重连；电脑需保持运行',
          )
      },
    )
    const reconnectOnVisible = (): void => {
      if (document.visibilityState === 'visible') schedule()
    }
    document.addEventListener('visibilitychange', reconnectOnVisible)
    return () => {
      disposed = true
      epoch.current++
      close()
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', reconnectOnVisible)
    }
  }, [sessionId])
  const loadOlder = useCallback(
    async (id: string, before: HistoryCursor): Promise<void> => {
      const older = await getSessionData(id, before)
      setData((current) =>
        current?.nextBefore?.rowId === before.rowId
          ? prependHistory(current, older)
          : current,
      )
    },
    [],
  )
  return {
    data,
    dangerLease,
    delegations,
    approvals,
    interactions,
    connection,
    notice,
    setNotice,
    refresh,
    loadOlder,
    streaming: cache.streaming,
    streamingReasoning: cache.streamingReasoning,
    runActivities: activity.runActivities,
  }
}
