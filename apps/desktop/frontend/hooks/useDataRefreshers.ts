import { useCallback } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type {
  Delegation,
  Project,
  ProviderProfile,
  Session,
} from '@reflexion-os-studio/runtime-client'
import { listProviders } from '../api/providers'
import { listProjects } from '../api/projects'
import { listDelegations } from '../api/agents'
import { getSessionData, listSessions, type SessionData } from '../api/sessions'

export interface DataRefresherDeps {
  /** 会话数据请求序号：刷新期间切会话时丢弃过期响应。 */
  sessionRequestRef: MutableRefObject<number>
  setSessionData: Dispatch<SetStateAction<SessionData | null>>
  setProfiles: Dispatch<SetStateAction<ProviderProfile[]>>
  setProjects: Dispatch<SetStateAction<Project[]>>
  setProjectSessions: Dispatch<SetStateAction<Session[]>>
  setStandaloneSessions: Dispatch<SetStateAction<Session[]>>
  setDelegations: Dispatch<SetStateAction<Delegation[]>>
}

export interface DataRefreshers {
  refreshSessionData: (sessionId: string) => Promise<void>
  refreshProfiles: () => Promise<void>
  refreshProjects: () => Promise<void>
  refreshProjectSessions: (projectId: string) => Promise<void>
  refreshStandaloneSessions: () => Promise<void>
  refreshDelegations: (sessionId: string) => Promise<void>
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
    setProjectSessions,
    setStandaloneSessions,
    setDelegations,
  } = deps

  const refreshSessionData = useCallback(
    async (sessionId: string) => {
      const requestId = ++sessionRequestRef.current
      const result = await getSessionData(sessionId)
      // 请求期间可能已切换到其他会话：丢弃过期响应，避免旧会话覆盖当前页。
      if (requestId === sessionRequestRef.current) setSessionData(result)
    },
    [sessionRequestRef, setSessionData],
  )

  const refreshProfiles = useCallback(async () => {
    const result = await listProviders()
    setProfiles(result.profiles)
  }, [setProfiles])

  const refreshProjects = useCallback(async () => {
    const result = await listProjects()
    setProjects(result.projects)
  }, [setProjects])

  const refreshProjectSessions = useCallback(
    async (projectId: string) => {
      const result = await listSessions(projectId)
      setProjectSessions(result.sessions)
    },
    [setProjectSessions],
  )

  const refreshStandaloneSessions = useCallback(async () => {
    const result = await listSessions(null)
    setStandaloneSessions(result.sessions)
  }, [setStandaloneSessions])

  const refreshDelegations = useCallback(
    async (sessionId: string) => {
      const delegationsList = await listDelegations(sessionId)
      setDelegations(delegationsList)
    },
    [setDelegations],
  )

  return {
    refreshSessionData,
    refreshProfiles,
    refreshProjects,
    refreshProjectSessions,
    refreshStandaloneSessions,
    refreshDelegations,
  }
}
