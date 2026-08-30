import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProviderProfile,
  Project,
  Session,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import {
  useAppBootstrap,
  type BootstrapSnapshot,
} from './hooks/useAppBootstrap'
import { useModelSelection } from './hooks/useModelSelection'
import { usePermissionMode } from './hooks/usePermissionMode'
import { listProviders } from './api/providers'
import { listProjects } from './api/projects'
import { resolveApproval } from './api/chat'
import { listSkills } from './api/skills'
import { getSessionData, listSessions, type SessionData } from './api/sessions'
import {
  ConfirmDialog,
  type ConfirmDialogState,
} from './components/ConfirmDialog'
import { ChatView } from './features/chat/ChatView'
import { LandingView } from './features/landing/LandingView'
import { MemoryView } from './features/memories/MemoryView'
import { Sidebar } from './components/Sidebar'
import { SkillsView } from './features/skills/SkillsView'
import { AutomationsView } from './features/automations/AutomationsView'
import { SettingsView } from './features/settings/SettingsView'
import { useSessionActions } from './hooks/useSessionActions'
import { DoubleChevronIcon } from './ui/icons'

const STATUS_LABELS: Record<string, string> = {
  starting: '正在启动本地 Runtime…',
  'runtime-ready': 'Chat Runtime 已就绪',
  'system-ready': '系统 Runtime 已就绪',
  'system-degraded': 'Chat 可用，工具 Runtime 不可用',
  error: '启动失败',
  stopping: '正在关闭…',
}

export default function App() {
  const [view, setView] = useState<
    'chat' | 'settings' | 'memories' | 'skills' | 'automations'
  >('chat')
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [skills, setSkills] = useState<SkillManifest[]>([])
  // SkillsView 点击"在对话中使用"：记一个 nonce 触发 Composer 预填 /<skillId>。
  const [composerPrefill, setComposerPrefill] = useState<{
    skillId: string
    nonce: number
  } | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectSessions, setProjectSessions] = useState<Session[]>([])
  const [standaloneSessions, setStandaloneSessions] = useState<Session[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  // 侧栏开合（单栏 Codex 式）：收起时隐藏侧栏但保留挂载状态。
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('reflexion.sidebarOpen') !== '0',
  )
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(
    null,
  )
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null)
  const activeProjectRef = useRef<string | null>(null)
  const activeSessionRef = useRef<string | null>(null)

  useEffect(() => {
    localStorage.setItem('reflexion.sidebarOpen', sidebarOpen ? '1' : '0')
  }, [sidebarOpen])

  const { permissionMode, changePermissionMode } = usePermissionMode()
  const { modelOptions, selectedModelKey, setSelectedModelKey } =
    useModelSelection(profiles, sessionData, activeSessionId)

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

  const {
    bootstrap,
    streaming,
    streamingReasoning,
    resetStreaming,
    pendingApprovals,
    memoryNotice,
  } = useAppBootstrap(bootstrapDeps)

  /** 审批决策：approval.resolve 命令；事件回执负责移除等待卡片。 */
  const handleResolveApproval = useCallback(
    async (
      toolCallId: string,
      decision: 'approved' | 'denied',
      scope: 'once' | 'session',
    ): Promise<void> => {
      try {
        await resolveApproval({ toolCallId, decision, scope })
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [],
  )

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
    permissionMode,
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
    : '启动中…'
  const runtimeReady = bootstrap?.runtimeReady ?? false

  // 技能清单是内置静态数据，runtime 一就绪就拉一次；失败不阻塞聊天。
  useEffect(() => {
    if (!runtimeReady) return
    listSkills()
      .then((result) => setSkills(result.skills))
      .catch(() => {})
  }, [runtimeReady])

  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null
  const contextTitle =
    view === 'settings'
      ? '设置'
      : view === 'memories'
        ? '记忆'
        : view === 'skills'
          ? '技能'
          : view === 'automations'
            ? '自动化'
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
        open={sidebarOpen}
        projects={projects}
        projectSessions={projectSessions}
        standaloneSessions={standaloneSessions}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        creatingProject={creatingProject}
        view={view}
        onSelectProject={selectProject}
        onSelectSession={openSession}
        onSelectStandaloneSession={selectStandaloneSession}
        onNewSessionInProject={selectProject}
        onNewChat={newStandaloneChat}
        onCreateProject={createProject}
        onDeleteProject={deleteProject}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        onSelectView={(nextView) => {
          // 底部导航：打开对应页面；点已激活项回到聊天。
          setView((current) => (current === nextView ? 'chat' : nextView))
        }}
      />
      <div className="main-pane">
        <header className="topbar">
          <button
            type="button"
            className="topbar-toggle"
            title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
            aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <DoubleChevronIcon direction={sidebarOpen ? 'left' : 'right'} />
          </button>
          <span className="topbar-title">{contextTitle}</span>
          <span className="spacer" />
          {memoryNotice && (
            <span className="badge badge-memory">{memoryNotice}</span>
          )}
          <span className={`badge badge-${bootstrap?.state ?? ''}`}>
            {statusLabel}
          </span>
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
        ) : view === 'memories' ? (
          <MemoryView confirm={confirm} />
        ) : view === 'skills' ? (
          <SkillsView
            onUseSkill={(skillId, sessionId) => {
              setActiveProjectId(null)
              setActiveSessionId(sessionId)
              void refreshSessionData(sessionId)
              void refreshStandaloneSessions()
              setComposerPrefill({ skillId, nonce: Date.now() })
              setView('chat')
            }}
          />
        ) : view === 'automations' ? (
          <AutomationsView />
        ) : activeSessionId ? (
          <ChatView
            sessionData={sessionData}
            streaming={streaming}
            streamingReasoning={streamingReasoning}
            hasEnabledProvider={hasEnabledProvider}
            permissionValue={permissionMode}
            onPermissionChange={changePermissionMode}
            modelOptions={modelOptions}
            selectedModelKey={selectedModelKey}
            onModelChange={setSelectedModelKey}
            skills={skills}
            composerPrefill={composerPrefill}
            onPrefillConsumed={() => setComposerPrefill(null)}
            onSend={sendMessage}
            onStop={stopRun}
            onRetry={retryRun}
            onGoSettings={() => {
              setView('settings')
            }}
            pendingApprovals={pendingApprovals}
            onResolveApproval={handleResolveApproval}
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
            composerPrefill={composerPrefill}
            onPrefillConsumed={() => setComposerPrefill(null)}
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
