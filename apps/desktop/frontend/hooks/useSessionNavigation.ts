import type { Dispatch, SetStateAction } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import type { SessionData } from '../api/sessions'
import type { SidebarMode } from './useSidebarPanel'

export type ViewName = 'chat' | 'settings' | 'skills' | 'automations'

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
  /** 确认并清空工作区文件（可能弹窗）；返回 false 表示用户取消切换。 */
  resetWorkspaceFiles: () => boolean | Promise<boolean>
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
    // 必须切回聊天视图：从技能/自动化/记忆/设置页点会话时，
    // 若不重置 view，主区仍渲染上一个页面，表现为"点了没反应"。
    // 新建对话入口能"救回来"，正是因为 newStandaloneChat 里执行了 setView('chat')。
    deps.setView('chat')
    deps.setActiveSessionId(sessionId)
    deps.resetStreaming()
    void deps.refreshSessionData(sessionId)
    void deps.refreshDelegations(sessionId)
  }

  const selectProject = (projectId: string): void => {
    void (async () => {
      if (!(await deps.resetWorkspaceFiles())) return
      deps.setActiveProjectId(projectId)
      deps.setActiveSessionId(null)
      deps.setSessionData(null)
      deps.setDelegations([])
      deps.setView('chat')
      void deps.refreshProjectSessions(projectId)
    })()
  }

  const selectLandingProject = (projectId: string | null): void => {
    void (async () => {
      // null（切到"独立对话"）同样会清空项目上下文并卸载脏编辑器，必须过守卫。
      if (!(await deps.resetWorkspaceFiles())) return
      deps.setActiveProjectId(projectId)
      deps.setActiveSessionId(null)
      deps.setSessionData(null)
      deps.setDelegations([])
      if (projectId !== null) {
        void deps.refreshProjectSessions(projectId)
      }
    })()
  }

  const selectStandaloneSession = (sessionId: string): void => {
    void (async () => {
      if (!(await deps.resetWorkspaceFiles())) return
      deps.setActiveProjectId(null)
      openSession(sessionId)
    })()
  }

  const newStandaloneChat = (): void => {
    void (async () => {
      if (!(await deps.resetWorkspaceFiles())) return
      deps.setActiveProjectId(null)
      deps.setActiveSessionId(null)
      deps.setSessionData(null)
      deps.setDelegations([])
      deps.setView('chat')
    })()
  }

  const enterProjectFiles = (projectId: string): void => {
    void (async () => {
      const switching = deps.activeProjectId !== projectId
      if (switching && !(await deps.resetWorkspaceFiles())) return
      deps.setActiveProjectId(projectId)
      deps.setView('chat')
      deps.setSidebarMode('files')
      deps.setSidebarOpen(true)
      void deps.refreshProjectSessions(projectId)
    })()
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
