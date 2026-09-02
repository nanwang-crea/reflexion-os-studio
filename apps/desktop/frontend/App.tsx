import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProviderProfile,
  Project,
  Session,
  SkillManifest,
} from '@reflexion-os-studio/runtime-client'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import { useModelSelection } from './hooks/useModelSelection'
import { usePermissionMode } from './hooks/usePermissionMode'
import { listProviders } from './api/providers'
import { listProjects } from './api/projects'
import { gitBranches } from './api/workspace'
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
import {
  WorkspacePanel,
  type WorkspaceOpenRequest,
} from './features/workspace/WorkspacePanel'
import { SettingsView } from './features/settings/SettingsView'
import { useSessionActions } from './hooks/useSessionActions'
import { useResourceRouter } from './hooks/useResourceRouter'
import { DoubleChevronIcon, FolderIcon } from './ui/icons'

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
  const [selectedGitBranch, setSelectedGitBranch] = useState<string | null>(
    null,
  )
  const [gitRepo, setGitRepo] = useState<boolean | null>(null)
  const [gitBranchesError, setGitBranchesError] = useState<string | null>(null)
  const [branchOptions, setBranchOptions] = useState<string[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionData, setSessionData] = useState<SessionData | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  // 侧栏开合（单栏 Codex 式）：收起时隐藏侧栏但保留挂载状态。
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('reflexion.sidebarOpen') !== '0',
  )
  // 对话右侧工作区面板（Codex 右侧文件栏式）：默认展开，按用户偏好记忆。
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => localStorage.getItem('reflexion.workspacePanel') !== '0',
  )
  // 资源链接点击产生的面板定位请求；nonce 区分每次点击。
  const [workspaceRequest, setWorkspaceRequest] =
    useState<WorkspaceOpenRequest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(
    null,
  )
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null)
  const activeProjectRef = useRef<string | null>(null)
  const activeSessionRef = useRef<string | null>(null)
  const sessionRequestRef = useRef(0)

  useEffect(() => {
    localStorage.setItem('reflexion.sidebarOpen', sidebarOpen ? '1' : '0')
  }, [sidebarOpen])

  useEffect(() => {
    localStorage.setItem('reflexion.workspacePanel', workspaceOpen ? '1' : '0')
  }, [workspaceOpen])

  const { permissionMode, changePermissionMode } = usePermissionMode()
  const { modelOptions, selectedModelKey, setSelectedModelKey } =
    useModelSelection(profiles, sessionData, activeSessionId)

  const refreshSessionData = useCallback(async (sessionId: string) => {
    const requestId = ++sessionRequestRef.current
    const result = await getSessionData(sessionId)
    // 请求期间可能已切换到其他会话：丢弃过期响应，避免旧会话覆盖当前页。
    if (requestId === sessionRequestRef.current) setSessionData(result)
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
    runActivities,
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
    setSelectedGitBranch(null)
    setGitRepo(null)
    setGitBranchesError(null)
    setBranchOptions([])
    setActiveSessionId(null)
    setSessionData(null)
    setView('chat')
    void refreshProjectSessions(projectId)
  }

  const selectLandingProject = useCallback(
    (projectId: string | null): void => {
      setActiveProjectId(projectId)
      setActiveSessionId(null)
      setSessionData(null)
      setSelectedGitBranch(null)
      setGitRepo(null)
      setGitBranchesError(null)
      setBranchOptions([])
      if (projectId !== null) void refreshProjectSessions(projectId)
    },
    [refreshProjectSessions],
  )

  useEffect(() => {
    if (
      activeProjectId === null ||
      activeSessionId !== null ||
      bootstrap?.systemReady !== true
    ) {
      return
    }
    let cancelled = false
    setBranchLoading(true)
    setGitBranchesError(null)
    void gitBranches(activeProjectId)
      .then((result) => {
        if (cancelled) return
        setGitRepo(result.repo)
        setBranchOptions(result.branches)
        setSelectedGitBranch(result.current ?? result.branches[0] ?? null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setGitRepo(null)
        setGitBranchesError(
          error instanceof Error ? error.message : String(error),
        )
        setBranchOptions([])
        setSelectedGitBranch(null)
      })
      .finally(() => {
        if (!cancelled) setBranchLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeProjectId, activeSessionId, bootstrap?.systemReady])

  const selectStandaloneSession = (sessionId: string): void => {
    setActiveProjectId(null)
    setSelectedGitBranch(null)
    setBranchOptions([])
    openSession(sessionId)
  }

  /** 回到“新对话”落地页；未选项目即独立对话模式。 */
  const newStandaloneChat = (): void => {
    setActiveProjectId(null)
    setSelectedGitBranch(null)
    setBranchOptions([])
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
    selectedGitBranch,
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

  const handleResourceClick = useResourceRouter({
    activeProjectRef,
    setWorkspaceRequest,
    setWorkspaceOpen,
    setNotice,
  })
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
          {view === 'chat' && (
            <button
              type="button"
              className={`topbar-toggle${workspaceOpen ? ' active' : ''}`}
              title={workspaceOpen ? '收起工作区面板' : '展开工作区面板'}
              aria-label="工作区面板"
              aria-pressed={workspaceOpen}
              onClick={() => setWorkspaceOpen((open) => !open)}
            >
              <FolderIcon />
            </button>
          )}
          {memoryNotice && (
            <span className="badge badge-memory">{memoryNotice}</span>
          )}
          <span className={`badge badge-${bootstrap?.state ?? ''}`}>
            {statusLabel}
          </span>
        </header>

        {notice && (
          <div className="notice" role="alert" aria-live="assertive">
            <span>{notice}</span>
            <button
              type="button"
              className="ghost"
              onClick={() => setNotice(null)}
            >
              关闭
            </button>
          </div>
        )}

        <div className="content-area">
          <div className="content-main">
            {view === 'settings' ? (
              <SettingsView
                profiles={profiles}
                onSaved={() => refreshProfiles()}
                onBackToChat={() => setView('chat')}
                confirm={confirm}
              />
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
                runActivities={runActivities}
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
                onResourceClick={handleResourceClick}
              />
            ) : (
              <LandingView
                project={activeProject}
                projects={projects}
                selectedProjectId={activeProjectId}
                onProjectChange={selectLandingProject}
                gitBranches={branchOptions}
                gitRepo={gitRepo}
                gitBranchesError={gitBranchesError}
                selectedGitBranch={selectedGitBranch}
                gitBranchesLoading={branchLoading}
                onGitBranchChange={setSelectedGitBranch}
                sessions={activeProject ? projectSessions : []}
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
                onSelectSession={openSession}
                onRenameSession={renameSession}
                onDeleteSession={deleteSession}
                onGoSettings={() => {
                  setView('settings')
                }}
              />
            )}
          </div>
          {view === 'chat' && workspaceOpen && (
            <WorkspacePanel
              project={activeProject}
              systemReady={bootstrap?.systemReady ?? false}
              openRequest={workspaceRequest}
            />
          )}
        </div>
      </div>
      <ConfirmDialog
        state={confirmState}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  )
}
