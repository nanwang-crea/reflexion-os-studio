import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProviderProfile,
  Project,
  Session,
} from '@reflexion-os-studio/runtime-client'
import { useAppBootstrap, type BootstrapSnapshot } from './useAppBootstrap'
import { useModelSelection } from './useModelSelection'
import { usePermissionMode } from './usePermissionMode'
import { listProviders } from './api/providers'
import { listProjects } from './api/projects'
import { getSessionData, listSessions, type SessionData } from './api/sessions'
import { ConfirmDialog, type ConfirmDialogState } from './ConfirmDialog'
import { ChatView } from './ChatView'
import { LandingView } from './LandingView'
import { Sidebar } from './Sidebar'
import { SettingsView } from './SettingsView'
import { useSessionActions } from './useSessionActions'

const STATUS_LABELS: Record<string, string> = {
  starting: '正在启动本地 Runtime…',
  'runtime-ready': 'Chat Runtime 已就绪',
  'system-ready': '系统 Runtime 已就绪',
  'system-degraded': 'Chat 可用，工具 Runtime 不可用',
  error: '启动失败',
  stopping: '正在关闭…',
}

export default function App() {
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectSessions, setProjectSessions] = useState<Session[]>([])
  const [standaloneSessions, setStandaloneSessions] = useState<Session[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(
    null,
  )
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null)
  const activeProjectRef = useRef<string | null>(null)
  const activeSessionRef = useRef<string | null>(null)

  const { permissionMode, changePermissionMode } = usePermissionMode()
  const { modelOptions, selectedModelKey, setSelectedModelKey } =
    useModelSelection(profiles)

  const refreshSessionData = useCallback(async (sessionId: string) => {
    const result = await getSessionData(sessionId)
    setSessionData(result)
  }, [])

  const refreshProfiles = useCallback(async () => {
    const result = await listProviders()
    setProfiles(result.profiles)
  }, [])

  const refreshProjects = useCallback(async () => {
    const result = await listProjects()
    setProjects(result.projects)
  }, [])

  const refreshProjectSessions = useCallback(async (projectId: string) => {
    const result = await listSessions(projectId)
    setProjectSessions(result.sessions)
  }, [])

  const refreshStandaloneSessions = useCallback(async () => {
    const result = await listSessions(null)
    setStandaloneSessions(result.sessions)
  }, [])

  // deps 对象必须稳定：useAppBootstrap 内部的引导 effect 以它为依赖，
  // 每次渲染重建会导致事件监听反复重挂、启动拉取反复触发。
  const bootstrapDeps = useMemo(
    () => ({
      activeSessionRef,
      activeProjectRef,
      refreshProfiles,
      refreshProjects,
      refreshSessionData,
      refreshStandaloneSessions,
      refreshProjectSessions,
      setNotice,
    }),
    [
      activeProjectRef,
      activeSessionRef,
      refreshProjectSessions,
      refreshProfiles,
      refreshProjects,
      refreshSessionData,
      refreshStandaloneSessions,
      setNotice,
    ],
  )

  const { bootstrap, streaming, resetStreaming } =
    useAppBootstrap(bootstrapDeps)

  useEffect(() => {
    activeSessionRef.current = activeSessionId
  }, [activeSessionId])

  useEffect(() => {
    activeProjectRef.current = activeProjectId
  }, [activeProjectId])

  /** 应用内确认弹窗：promise 风格，供变更类操作等待用户决定。 */
  const confirm = useCallback((state: ConfirmDialogState): Promise<boolean> => {
    return new Promise((resolve) => {
      // 理论上不会连开两个弹窗；万一发生，先了结旧 promise 避免挂起。
      confirmResolverRef.current?.(false)
      confirmResolverRef.current = resolve
      setConfirmState(state)
    })
  }, [])

  const settleConfirm = useCallback((ok: boolean): void => {
    setConfirmState(null)
    confirmResolverRef.current?.(ok)
    confirmResolverRef.current = null
  }, [])

  const handleConfirm = useCallback(() => settleConfirm(true), [settleConfirm])
  const handleCancel = useCallback(() => settleConfirm(false), [settleConfirm])

  const openSession = (sessionId: string): void => {
    setActiveSessionId(sessionId)
    resetStreaming()
    void refreshSessionData(sessionId)
  }

  const selectProject = (projectId: string): void => {
    setActiveProjectId(projectId)
    setActiveSessionId(null)
    setSessionData(null)
    setView('chat')
    void refreshProjectSessions(projectId)
  }

  const selectStandaloneSession = (sessionId: string): void => {
    setActiveProjectId(null)
    openSession(sessionId)
  }

  /** 回到“新对话”落地页；未选项目即独立对话模式。 */
  const newStandaloneChat = (): void => {
    setActiveProjectId(null)
    setActiveSessionId(null)
    setSessionData(null)
    setView('chat')
  }

  const {
    createProject,
    deleteProject,
    renameSession,
    deleteSession,
    sendMessage,
    stopRun,
    retryRun,
  } = useSessionActions({
    projects,
    activeSessionId,
    activeProjectId,
    selectedModelKey,
    sessionData,
    activeSessionRef,
    activeProjectRef,
    refreshSessionData,
    refreshStandaloneSessions,
    refreshProjectSessions,
    refreshProjects,
    setActiveSessionId,
    setActiveProjectId,
    setSessionData,
    setProjectSessions,
    setCreatingProject,
    setNotice,
    confirm,
    selectProject,
  })

  const hasEnabledProvider = profiles.some((profile) => profile.enabled)
  const statusLabel = bootstrap
    ? (STATUS_LABELS[bootstrap.state] ?? bootstrap.state)
    : '正在启动…'
  const runtimeReady = bootstrap?.runtimeReady ?? false

  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null
  const contextTitle =
    view === 'settings'
      ? '设置'
      : activeSessionId
        ? (sessionData?.session?.title ?? '对话')
        : activeProject
          ? activeProject.name
          : '新对话'

  if (!runtimeReady) {
    return (
      <div className="boot-screen">
        <h1>ReflexionOS Studio</h1>
        <p className="boot-status">{statusLabel}</p>
        <p className="boot-detail">{bootstrap?.detail ?? 'M0 Bootstrap'}</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        projectSessions={projectSessions}
        standaloneSessions={standaloneSessions}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        creatingProject={creatingProject}
        onSelectProject={selectProject}
        onSelectSession={openSession}
        onSelectStandaloneSession={selectStandaloneSession}
        onNewSessionInProject={selectProject}
        onNewChat={newStandaloneChat}
        onCreateProject={createProject}
        onDeleteProject={deleteProject}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
      />
      <div className="main-pane">
        <header className="topbar">
          <span className="topbar-title">{contextTitle}</span>
          <span className="spacer" />
          <span className={`badge badge-${bootstrap?.state ?? ''}`}>
            {statusLabel}
          </span>
          <button
            className="ghost"
            onClick={() => {
              setView(view === 'settings' ? 'chat' : 'settings')
            }}
          >
            设置
          </button>
        </header>

        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button className="ghost" onClick={() => setNotice(null)}>
              关闭
            </button>
          </div>
        )}

        {view === 'settings' ? (
          <SettingsView profiles={profiles} onSaved={() => refreshProfiles()} />
        ) : activeSessionId ? (
          <ChatView
            sessionData={sessionData}
            streaming={streaming}
            hasEnabledProvider={hasEnabledProvider}
            permissionValue={permissionMode}
            onPermissionChange={changePermissionMode}
            modelOptions={modelOptions}
            selectedModelKey={selectedModelKey}
            onModelChange={setSelectedModelKey}
            onSend={sendMessage}
            onStop={stopRun}
            onRetry={retryRun}
            onGoSettings={() => {
              setView('settings')
            }}
          />
        ) : (
          <LandingView
            project={activeProject}
            sessions={activeProject ? projectSessions : []}
            hasEnabledProvider={hasEnabledProvider}
            permissionValue={permissionMode}
            onPermissionChange={changePermissionMode}
            modelOptions={modelOptions}
            selectedModelKey={selectedModelKey}
            onModelChange={setSelectedModelKey}
            onSend={sendMessage}
            onSelectSession={openSession}
            onRenameSession={renameSession}
            onDeleteSession={deleteSession}
            onGoSettings={() => {
              setView('settings')
            }}
          />
        )}
      </div>
      <ConfirmDialog
        state={confirmState}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  )
}
