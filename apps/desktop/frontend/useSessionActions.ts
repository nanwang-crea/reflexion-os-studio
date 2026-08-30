import type { RefObject } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import type { Project, Session } from '@reflexion-os-studio/runtime-client'
import type { ConfirmDialogState } from './ConfirmDialog'
import * as chatApi from './api/chat'
import {
  createProject as createProjectApi,
  deleteProject as deleteProjectApi,
} from './api/projects'
import * as sessionsApi from './api/sessions'
import type { SessionData } from './api/sessions'

interface SessionActionsDeps {
  // 选择状态（渲染值）
  projects: Project[]
  activeSessionId: string | null
  activeProjectId: string | null
  selectedModelKey: string | null
  sessionData: SessionData | null
  /** 工具权限 Profile（随 message.send 传给 Runtime）。 */
  permissionMode: string
  // 与渲染同步的 refs
  activeSessionRef: RefObject<string | null>
  activeProjectRef: RefObject<string | null>
  // 刷新函数
  refreshSessionData: (sessionId: string) => Promise<void>
  refreshStandaloneSessions: () => Promise<void>
  refreshProjectSessions: (projectId: string) => Promise<void>
  refreshProjects: () => Promise<void>
  // 状态写入
  setActiveSessionId: (sessionId: string | null) => void
  setActiveProjectId: (projectId: string | null) => void
  setSessionData: (data: SessionData | null) => void
  setProjectSessions: (sessions: Session[]) => void
  setCreatingProject: (creating: boolean) => void
  setNotice: (notice: string | null) => void
  // 应用内确认弹窗（替代系统原生 ask）
  confirm: (state: ConfirmDialogState) => Promise<boolean>
  // 视图行为：项目创建后进入该项目
  selectProject: (projectId: string) => void
}

/**
 * 会话与项目的变更类操作（创建/删除/重命名、发消息、停止与重试）。
 * 只编排请求与状态刷新，不含视图装配；选择类行为仍留在 App。
 */
export function useSessionActions(deps: SessionActionsDeps): {
  createProject: () => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  stopRun: () => Promise<void>
  retryRun: () => Promise<void>
} {
  const fail = (error: unknown): void => {
    deps.setNotice(error instanceof Error ? error.message : String(error))
  }

  const renameSession = async (
    sessionId: string,
    title: string,
  ): Promise<void> => {
    deps.setNotice(null)
    try {
      await sessionsApi.renameSession(sessionId, title)
      if (deps.activeSessionRef.current === sessionId) {
        await deps.refreshSessionData(sessionId)
      }
      await deps.refreshStandaloneSessions()
      if (deps.activeProjectRef.current) {
        await deps.refreshProjectSessions(deps.activeProjectRef.current)
      }
    } catch (error) {
      fail(error)
    }
  }

  const deleteSession = async (sessionId: string): Promise<void> => {
    const confirmed = await deps.confirm({
      title: '删除会话',
      message: '删除后该会话的聊天记录无法恢复。确定删除？',
      danger: true,
      confirmLabel: '删除',
    })
    if (!confirmed) return
    deps.setNotice(null)
    try {
      await sessionsApi.deleteSession(sessionId)
      if (deps.activeSessionRef.current === sessionId) {
        deps.setActiveSessionId(null)
        deps.setSessionData(null)
      }
      await deps.refreshStandaloneSessions()
      if (deps.activeProjectRef.current) {
        await deps.refreshProjectSessions(deps.activeProjectRef.current)
      }
    } catch (error) {
      fail(error)
    }
  }

  const deleteProject = async (projectId: string): Promise<void> => {
    const project = deps.projects.find((item) => item.id === projectId)
    const confirmed = await deps.confirm({
      title: '删除项目',
      message: `删除项目“${project?.name ?? ''}”会一并删除其下所有会话和聊天记录，且无法恢复。确定删除？`,
      danger: true,
      confirmLabel: '删除',
    })
    if (!confirmed) return
    deps.setNotice(null)
    try {
      await deleteProjectApi(projectId)
      if (deps.activeProjectRef.current === projectId) {
        deps.setActiveProjectId(null)
        deps.setActiveSessionId(null)
        deps.setSessionData(null)
        deps.setProjectSessions([])
      }
      await deps.refreshProjects()
    } catch (error) {
      fail(error)
    }
  }

  const createProject = async (): Promise<void> => {
    deps.setCreatingProject(true)
    deps.setNotice(null)
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择项目文件夹',
      })
      if (typeof selected !== 'string' || selected === '') return
      const result = await createProjectApi(selected)
      await deps.refreshProjects()
      deps.selectProject(result.project.id)
    } catch (error) {
      fail(error)
    } finally {
      deps.setCreatingProject(false)
    }
  }

  const sendMessage = async (content: string): Promise<void> => {
    deps.setNotice(null)
    // 模型选择形如 `${providerId}::${model}`；未选择时由 Runtime 回退默认。
    const modelKey = deps.selectedModelKey
    const separator = modelKey ? modelKey.indexOf('::') : -1
    const providerId =
      modelKey && separator > 0 ? modelKey.slice(0, separator) : undefined
    const model =
      modelKey && separator > 0 ? modelKey.slice(separator + 2) : undefined
    const permissionMode =
      deps.permissionMode === 'read-only' ? 'read-only' : undefined
    try {
      let sessionId = deps.activeSessionId
      if (!sessionId) {
        // 落地页直接发言：选中项目则在项目内建会话，否则建独立会话。
        const created = await sessionsApi.createSession(deps.activeProjectId)
        await chatApi.sendMessage({
          sessionId: created.session.id,
          content,
          providerId,
          model,
          permissionMode,
        })
        sessionId = created.session.id
        deps.setActiveSessionId(sessionId)
      } else {
        await chatApi.sendMessage({
          sessionId,
          content,
          providerId,
          model,
          permissionMode,
        })
      }
      await deps.refreshSessionData(sessionId)
      await deps.refreshStandaloneSessions()
      if (deps.activeProjectId) {
        await deps.refreshProjectSessions(deps.activeProjectId)
      }
    } catch (error) {
      fail(error)
    }
  }

  const stopRun = async (): Promise<void> => {
    const activeRun = deps.sessionData?.runs.find(
      (run) =>
        run.status === 'created' ||
        run.status === 'running' ||
        run.status === 'awaiting_approval',
    )
    if (!activeRun) return
    try {
      await chatApi.cancelRun(activeRun.id)
    } catch (error) {
      fail(error)
    }
  }

  const retryRun = async (): Promise<void> => {
    if (!deps.activeSessionId || !deps.sessionData) return
    const lastFinishedBadly = [...deps.sessionData.runs]
      .reverse()
      .find(
        (run) =>
          run.status === 'failed' ||
          run.status === 'interrupted' ||
          run.status === 'cancelled',
      )
    if (!lastFinishedBadly) return
    try {
      await chatApi.retryRun(lastFinishedBadly.id)
      await deps.refreshSessionData(deps.activeSessionId)
    } catch (error) {
      fail(error)
    }
  }

  return {
    createProject,
    deleteProject,
    renameSession,
    deleteSession,
    sendMessage,
    stopRun,
    retryRun,
  }
}
