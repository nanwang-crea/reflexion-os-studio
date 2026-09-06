import type { Dispatch, SetStateAction } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import type { SessionData } from '../api/sessions'
import type { SidebarMode } from './useSidebarPanel'

export type ViewName =
  'chat' | 'settings' | 'memories' | 'skills' | 'automations'

export interface SessionNavigationDeps {
  activeProjectId: string | null
  setActiveProjectId: Dispatch<SetStateAction<string | null>>
  setActiveSessionId: Dispatch<SetStateAction<string | null>>
  setSessionData: Dispatch<SetStateAction<SessionData | null>>
  setDelegations: Dispatch<SetStateAction<Delegation[]>>
  setView: Dispatch<SetStateAction<ViewName>>
  setSidebarMode: Dispatch<SetStateAction<SidebarMode>>
  setSidebarOpen: Dispatch<SetStateAction<boolean>>
  resetStreaming: () => void
  refreshSessionData: (sessionId: string) => Promise<void>
  refreshProjectSessions: (projectId: string) => Promise<void>
  refreshDelegations: (sessionId: string) => Promise<void>
  resetWorkspaceFiles: () => void
}

export interface SessionNavigation {
  openSession: (sessionId: string) => void
  /** 选择项目：回到该项目的落地页并刷新其会话列表。 */
  selectProject: (projectId: string) => void
  /** 落地页切换上下文项目；null 表示独立会话上下文。 */
  selectLandingProject: (projectId: string | null) => void
  selectStandaloneSession: (sessionId: string) => void
  newStandaloneChat: () => void
  /** 点击项目行文件图标：切到对应项目并让侧栏进入文件工作区。 */
  enterProjectFiles: (projectId: string) => void
  /** 侧栏文件工作区返回会话列表。 */
  backToChat: () => void
}

/**
 * 会话/项目切换导航：所有"打开某个会话或项目"的动作集中在此，
 * 统一负责清空旧上下文、刷新对应列表与工作区文件标签。
 */
export function useSessionNavigation(
  deps: SessionNavigationDeps,
): SessionNavigation {
  const openSession = (sessionId: string): void => {
    deps.setActiveSessionId(sessionId)
    deps.resetStreaming()
    void deps.refreshSessionData(sessionId)
    void deps.refreshDelegations(sessionId)
  }

  const selectProject = (projectId: string): void => {
    deps.setActiveProjectId(projectId)
    deps.setActiveSessionId(null)
    deps.setSessionData(null)
    deps.setDelegations([])
    deps.setView('chat')
    // 文件标签只属于当前项目：切项目时清空。
    deps.resetWorkspaceFiles()
    void deps.refreshProjectSessions(projectId)
  }

  const selectLandingProject = (projectId: string | null): void => {
    deps.setActiveProjectId(projectId)
    deps.setActiveSessionId(null)
    deps.setSessionData(null)
    deps.setDelegations([])
    if (projectId !== null) {
      deps.resetWorkspaceFiles()
      void deps.refreshProjectSessions(projectId)
    }
  }

  const selectStandaloneSession = (sessionId: string): void => {
    deps.setActiveProjectId(null)
    openSession(sessionId)
  }

  const newStandaloneChat = (): void => {
    deps.setActiveProjectId(null)
    deps.setActiveSessionId(null)
    deps.setSessionData(null)
    deps.setDelegations([])
    deps.setView('chat')
  }

  const enterProjectFiles = (projectId: string): void => {
    deps.setActiveProjectId(projectId)
    deps.setView('chat')
    deps.setSidebarMode('files')
    deps.setSidebarOpen(true)
    if (deps.activeProjectId !== projectId) {
      deps.resetWorkspaceFiles()
    }
    void deps.refreshProjectSessions(projectId)
  }

  const backToChat = (): void => {
    deps.setSidebarMode('chat')
  }

  return {
    openSession,
    selectProject,
    selectLandingProject,
    selectStandaloneSession,
    newStandaloneChat,
    enterProjectFiles,
    backToChat,
  }
}
