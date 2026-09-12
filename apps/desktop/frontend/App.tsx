import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProviderProfile,
  Project,
  Session,
  SkillManifest,
  Delegation,
} from '@reflexion-os-studio/runtime-client'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import { useModelSelection } from './hooks/useModelSelection'
import { usePermissionMode } from './hooks/usePermissionMode'
import { useSidebarPanel } from './hooks/useSidebarPanel'
import { useWorkspacePanel } from './hooks/useWorkspacePanel'
import { useConfirmDialog } from './hooks/useConfirmDialog'
import { useDataRefreshers } from './hooks/useDataRefreshers'
import {
  useSessionNavigation,
  type ViewName,
} from './hooks/useSessionNavigation'
import { resolveApproval } from './api/chat'
import { listSkills } from './api/skills'
import type { SessionData } from './api/sessions'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ToastHost } from './components/Toast'
import { ResizeHandle } from './components/ResizeHandle'
import { TopBar, STATUS_LABELS } from './components/TopBar'
import { ChatView } from './features/chat/ChatView'
import { LandingView } from './features/landing/LandingView'
import { MemoryView } from './features/memories/MemoryView'
import { Sidebar } from './components/Sidebar'
import { SkillsView } from './features/skills/SkillsView'
import { AutomationsView } from './features/automations/AutomationsView'
import { FileViewerPanel } from './features/workspace/FileViewerPanel'
import { SettingsView } from './features/settings/SettingsView'
import { useSessionActions } from './hooks/useSessionActions'
import { useResourceRouter } from './hooks/useResourceRouter'

export default function App() {
  const [view, setView] = useState<ViewName>('chat')
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
  const [delegations, setDelegations] = useState<Delegation[]>([])
  const [creatingProject, setCreatingProject] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const activeProjectRef = useRef<string | null>(null)
  const activeSessionRef = useRef<string | null>(null)
  const sessionRequestRef = useRef(0)

  // 侧栏与右侧工作区面板状态分别由专属 hook 管理（含 localStorage 持久化）。
  const {
    sidebarOpen,
    setSidebarOpen,
    sidebarMode,
    setSidebarMode,
    sidebarWidth,
    setSidebarWidth,
  } = useSidebarPanel()
  const {
    workspaceOpen,
    setWorkspaceOpen,
    workspaceWidth,
    setWorkspaceWidth,
    openTabs,
    activeFilePath,
    filesFocusAssetId,
    setFilesFocusAssetId,
    workspaceRequest,
    setWorkspaceRequest,
    openFile,
    openDiff,
    closeTab,
    selectTab,
    reorderTabs,
    resetWorkspaceFiles,
  } = useWorkspacePanel()
  const { confirmState, confirm, handleConfirm, handleCancel } =
    useConfirmDialog()

  const { permissionMode, changePermissionMode } = usePermissionMode()
  const { modelOptions, selectedModelKey, setSelectedModelKey } =
    useModelSelection(profiles, sessionData, activeSessionId)

  const {
    refreshSessionData,
    refreshProfiles,
    refreshProjects,
    refreshProjectSessions,
    refreshStandaloneSessions,
    refreshDelegations,
  } = useDataRefreshers({
    sessionRequestRef,
    setSessionData,
    setProfiles,
    setProjects,
    setProjectSessions,
    setStandaloneSessions,
    setDelegations,
  })

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
      refreshDelegations,
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
      refreshDelegations,
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
    clearPendingApproval,
    restorePendingApproval,
    memoryNotice,
    runningSessionIds,
    completedSessionIds,
    failedSessionIds,
    approvalSessionIds,
    clearSessionStatus,
    retryTick,
  } = useAppBootstrap(bootstrapDeps)

  const {
    openSession,
    selectProject,
    selectLandingProject,
    selectStandaloneSession,
    newStandaloneChat,
    enterProjectFiles,
    backToChat,
  } = useSessionNavigation({
    activeProjectId,
    setActiveProjectId,
    setActiveSessionId,
    setSessionData,
    setDelegations,
    setView,
    setSidebarMode,
    setSidebarOpen,
    resetStreaming,
    refreshSessionData,
    refreshProjectSessions,
    refreshDelegations,
    resetWorkspaceFiles,
  })

  /**
   * 审批决策：approval.resolve 命令；卡片本地乐观摘除，点击即消失，
   * 不等 approval.resolved 事件走完 runtime→宿主→webview 往返（同一
   * 事件管道积压时卡片会滞留）。命令失败则恢复等待卡重试；
   * 事件回执到达时按 toolCallId 幂等，摘除已不存在的卡无副作用。
   */
  const handleResolveApproval = useCallback(
    async (
      toolCallId: string,
      decision: 'approved' | 'denied',
      scope: 'once' | 'session',
    ): Promise<void> => {
      const entry = pendingApprovals.find(
        (item) => item.toolCallId === toolCallId,
      )
      if (entry !== undefined) clearPendingApproval(toolCallId)
      try {
        await resolveApproval({ toolCallId, decision, scope })
      } catch (error) {
        if (entry !== undefined) restorePendingApproval(entry)
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [pendingApprovals, clearPendingApproval, restorePendingApproval],
  )

  useEffect(() => {
    activeSessionRef.current = activeSessionId
  }, [activeSessionId])

  useEffect(() => {
    activeProjectRef.current = activeProjectId
  }, [activeProjectId])

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

  // 点击会话行进入会话即视为"已确认"：清除该会话的完成/失败侧栏标记。
  const handleSelectSession = useCallback(
    (sessionId: string): void => {
      clearSessionStatus(sessionId)
      openSession(sessionId)
    },
    [clearSessionStatus, openSession],
  )
  const handleSelectStandaloneSession = useCallback(
    (sessionId: string): void => {
      clearSessionStatus(sessionId)
      selectStandaloneSession(sessionId)
    },
    [clearSessionStatus, selectStandaloneSession],
  )

  const handleResourceClick = useResourceRouter({
    activeProjectRef,
    setWorkspaceRequest,
    setWorkspaceOpen,
    setNotice,
  })

  useEffect(() => {
    const request = workspaceRequest
    if (request === null) return
    if (request.kind === 'file') {
      openFile(request.path, request.line)
    } else {
      setSidebarMode('files')
      setSidebarOpen(true)
      setFilesFocusAssetId(request.assetId)
    }
  }, [
    workspaceRequest,
    openFile,
    setFilesFocusAssetId,
    setSidebarMode,
    setSidebarOpen,
  ])

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
        width={sidebarWidth}
        mode={sidebarMode}
        projects={projects}
        projectSessions={projectSessions}
        standaloneSessions={standaloneSessions}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        runningSessionIds={runningSessionIds}
        completedSessionIds={completedSessionIds}
        failedSessionIds={failedSessionIds}
        approvalSessionIds={approvalSessionIds}
        creatingProject={creatingProject}
        view={view}
        systemReady={bootstrap?.systemReady ?? false}
        activeFilePath={openTabs.length > 0 ? activeFilePath : null}
        focusAssetId={filesFocusAssetId}
        onFocusConsumed={() => setFilesFocusAssetId(null)}
        onOpenFile={openFile}
        onOpenDiff={openDiff}
        onEnterProjectFiles={enterProjectFiles}
        onBackToChat={backToChat}
        onSelectProject={selectProject}
        onSelectSession={handleSelectSession}
        onSelectStandaloneSession={handleSelectStandaloneSession}
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
      <ResizeHandle
        onResize={(delta) =>
          setSidebarWidth((width) =>
            Math.max(200, Math.min(560, width + delta)),
          )
        }
      />
      <div className="main-pane">
        <TopBar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          contextTitle={contextTitle}
          showWorkspaceToggle={view === 'chat'}
          workspaceOpen={workspaceOpen}
          onToggleWorkspace={() => setWorkspaceOpen((open) => !open)}
          memoryNotice={memoryNotice}
          runtimeState={bootstrap?.state ?? ''}
          statusLabel={statusLabel}
        />

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
                delegations={delegations}
                streaming={streaming}
                streamingReasoning={streamingReasoning}
                runActivities={runActivities}
                retryTick={retryTick}
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
                onOpenDiff={openDiff}
              />
            ) : (
              <LandingView
                project={activeProject}
                projects={projects}
                selectedProjectId={activeProjectId}
                onProjectChange={selectLandingProject}
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
            <>
              <ResizeHandle
                onResize={(delta) =>
                  setWorkspaceWidth((width) =>
                    Math.max(280, Math.min(900, width - delta)),
                  )
                }
              />
              <FileViewerPanel
                project={activeProject}
                systemReady={bootstrap?.systemReady ?? false}
                openTabs={openTabs}
                activePath={activeFilePath}
                onSelectTab={selectTab}
                onCloseTab={closeTab}
                onReorderTabs={reorderTabs}
                onResourceClick={handleResourceClick}
                width={workspaceWidth}
              />
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        state={confirmState}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
      <ToastHost />
    </div>
  )
}
