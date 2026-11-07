import { useCallback, useRef } from 'react'
import { mergeLatestHistory, prependHistory } from './session/history-pages'
import {
  mergeLiveMessage,
  mergeLiveRun,
  mergeLiveSession,
} from './session/live-merge'
import type { HistoryCursor } from '@reflexion-os-studio/runtime-client'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type {
  Delegation,
  Message,
  Project,
  ProviderProfile,
  Run,
  Session,
} from '@reflexion-os-studio/runtime-client'
import { listProviders } from '../api/providers'
import { listProjects } from '../api/projects'
import { listDelegations } from '../api/agents'
import { getSessionData, listSessions, type SessionData } from '../api/sessions'

export interface DataRefresherDeps {
  activeSessionId: string | null
  /** 会话数据请求序号：刷新期间切会话时丢弃过期响应。 */
  sessionRequestRef: MutableRefObject<number>
  setSessionData: Dispatch<SetStateAction<SessionData | null>>
  setProfiles: Dispatch<SetStateAction<ProviderProfile[]>>
  setProjects: Dispatch<SetStateAction<Project[]>>
  setAllSessions: Dispatch<SetStateAction<Session[]>>
  setDelegations: Dispatch<SetStateAction<Delegation[]>>
}

export interface DataRefreshers {
  refreshSessionData: (sessionId: string) => Promise<void>
  loadOlderHistory: (sessionId: string, before: HistoryCursor) => Promise<void>
  refreshProfiles: () => Promise<void>
  refreshProjects: () => Promise<void>
  /** 一次性刷新全部会话（含项目会话与独立会话），驱动侧栏全部分组。 */
  refreshSessions: () => Promise<void>
  refreshDelegations: (sessionId: string) => Promise<void>
  /**
   * 运行时事件载荷的即时合并（不经整页 session.get）：
   * 发送/入队/重试产生的消息与 Run 可以立刻上屏。
   */
  applyLiveMessage: (message: Message) => void
  applyLiveRun: (run: Run) => void
  applyLiveSession: (session: Session) => void
}

/**
 * 各领域数据的刷新函数集合：统一走 api/ 层请求并回填状态，
 * 组件只调具名函数不直连传输层。setters/ref 均稳定，返回函数引用稳定。
 */
export function useDataRefreshers(deps: DataRefresherDeps): DataRefreshers {
  const {
    sessionRequestRef,
    setSessionData,
    setProfiles,
    setProjects,
    setAllSessions,
    setDelegations,
  } = deps

  const active = useRef({ sessionId: deps.activeSessionId })
  active.current = { sessionId: deps.activeSessionId }
  const sessionsListRequestRef = useRef(0)
  const delegationRequestRef = useRef(0)
  /**
   * 同一会话的整页刷新单飞 + 尾随合并：一次发送会同时触发多个事件，
   * 若每个事件都发一次 session.get，大会话（历史页可达数 MB）会连续
   * 序列化/解析多遍。飞行中的请求结束后最多再补一次，保证不丢最新状态。
   */
  const sessionFlights = useRef(
    new Map<string, { promise: Promise<void>; pending: boolean }>(),
  )

  const refreshSessionData = useCallback(
    (sessionId: string): Promise<void> => {
      // 调用方（openSession / 落地页首条消息）会在 setActiveSessionId 的
      // 同一拍发起刷新，此刻 React 尚未提交新的 activeSessionId。
      // 先记下刷新目标，避免首拉结果在提交前被判成过期响应而丢弃；
      // 下一次渲染会以真实 props 覆盖回来。
      active.current = { sessionId }
      const flying = sessionFlights.current.get(sessionId)
      if (flying) {
        flying.pending = true
        return flying.promise
      }
      const flight = { promise: Promise.resolve(), pending: false }
      const load = async (): Promise<void> => {
        // 首拉无条件发起；尾随触发只在仍停留于该会话时合并，避免切走后
        // 为一个已不再展示的会话反复拉取。
        for (;;) {
          flight.pending = false
          const requestId = ++sessionRequestRef.current
          const result = await getSessionData(sessionId)
          // 请求期间可能已切换到其他会话：丢弃过期响应，避免旧会话覆盖当前页。
          if (
            requestId === sessionRequestRef.current &&
            active.current.sessionId === sessionId
          )
            setSessionData((current) => mergeLatestHistory(current, result))
          // 已切走的会话不再补拉；仍在当前会话则合并一次尾随触发。
          if (!flight.pending || active.current.sessionId !== sessionId) break
        }
      }
      flight.promise = load().finally(() => {
        sessionFlights.current.delete(sessionId)
      })
      sessionFlights.current.set(sessionId, flight)
      return flight.promise
    },
    [sessionRequestRef, setSessionData],
  )

  const applyLiveMessage = useCallback(
    (message: Message): void => {
      if (active.current.sessionId !== message.sessionId) return
      setSessionData((current) =>
        current === null ? current : mergeLiveMessage(current, message),
      )
    },
    [setSessionData],
  )

  const applyLiveRun = useCallback(
    (run: Run): void => {
      if (active.current.sessionId !== run.sessionId) return
      setSessionData((current) =>
        current === null ? current : mergeLiveRun(current, run),
      )
    },
    [setSessionData],
  )

  const applyLiveSession = useCallback(
    (session: Session): void => {
      if (active.current.sessionId !== session.id) return
      setSessionData((current) =>
        current === null ? current : mergeLiveSession(current, session),
      )
    },
    [setSessionData],
  )

  const loadOlderHistory = useCallback(
    async (sessionId: string, before: HistoryCursor) => {
      const result = await getSessionData(sessionId, before)
      if (active.current.sessionId !== sessionId) return
      setSessionData((current) => {
        if (
          current?.session?.id !== sessionId ||
          current.nextBefore?.rowId !== before.rowId ||
          current.nextBefore?.createdAt !== before.createdAt
        )
          return current
        return prependHistory(current, result)
      })
    },
    [setSessionData],
  )

  const refreshProfiles = useCallback(async () => {
    const result = await listProviders()
    setProfiles(result.profiles)
  }, [setProfiles])

  const refreshProjects = useCallback(async () => {
    const result = await listProjects()
    setProjects(result.projects)
  }, [setProjects])

  const refreshSessions = useCallback(async () => {
    // session.list 不带 projectId 即返回全部会话：一次请求同时覆盖
    // 侧栏的各项目分组与独立会话分组（多项目可同时展开，无需逐项目刷新）。
    const requestId = ++sessionsListRequestRef.current
    const result = await listSessions()
    if (requestId === sessionsListRequestRef.current)
      setAllSessions(result.sessions)
  }, [setAllSessions])

  const refreshDelegations = useCallback(
    async (sessionId: string) => {
      const requestId = ++delegationRequestRef.current
      const delegationsList = await listDelegations(sessionId)
      if (
        requestId === delegationRequestRef.current &&
        active.current.sessionId === sessionId
      )
        setDelegations(delegationsList)
    },
    [setDelegations],
  )

  return {
    refreshSessionData,
    loadOlderHistory,
    refreshProfiles,
    refreshProjects,
    refreshSessions,
    refreshDelegations,
    applyLiveMessage,
    applyLiveRun,
    applyLiveSession,
  }
}
