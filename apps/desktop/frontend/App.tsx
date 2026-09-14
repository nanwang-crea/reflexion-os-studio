import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  ProviderProfile,
  Project,
  Session,
  SkillManifest,
  Delegation,
} from '@reflexion-os-studio/runtime-client'
import { AppMain } from './AppMain'
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
import { showToast, ToastHost } from './components/Toast'
import { ResizeHandle } from './components/ResizeHandle'
import { STATUS_LABELS } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { terminalManager } from './features/terminal/manager'
import type { FileViewerPanelHandle } from './features/workspace/FileViewerPanel'
import { useWorkspaceTabGuard } from './hooks/useWorkspaceTabGuard'
import { useAppHotkeys } from './hooks/useAppHotkeys'
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
    activeTabId,
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
    reloadAllTextTabs,
    dirtyPaths,
    setTabDirty,
  } = useWorkspacePanel()
  const {
    confirmState,
    confirm,
    confirmAction,
    handleConfirm,
    handleTertiary,
    handleCancel,
  } = useConfirmDialog()

  // 终端面板开合状态存在 manager 单例里（跨页面保活、键击零 React），
  // App 只订阅 boolean 供顶栏按钮呈现激活态（AGENTS §11）。
  const terminalOpen = useSyncExternalStore(
    terminalManager.subscribe,
    terminalManager.selectPanelOpen,
  )
  const handleToggleTerminal = useCallback(
    () => terminalManager.togglePanel(),
    [],
  )

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

  const filePanelRef = useRef<FileViewerPanelHandle>(null)
  const { requestCloseTab, guardDirtyBuffersThen, guardedResetWorkspaceFiles } =
    useWorkspaceTabGuard({
      openTabs,
      dirtyPaths,
      closeTab,
      resetWorkspaceFiles,
      confirmAction,
      setNotice,
      filePanelRef,
    })
  useAppHotkeys({
    saveActive: () => {
      // 面板对用户不可见时不动作：工作区收起或不在聊天视图时，
      // 快捷键不应保存/关闭隐藏的标签。
      if (view !== 'chat' || !workspaceOpen) return
      if (activeFilePath === null || !dirtyPaths.has(activeFilePath)) return
      void filePanelRef.current?.saveDirty(activeFilePath).then((ok) => {
        if (ok === false) showToast('保存失败，请在编辑器中查看错误', 'error')
      })
    },
    closeActiveTab: () => {
      if (view !== 'chat' || !workspaceOpen) return
      if (activeTabId !== null) void requestCloseTab(activeTabId)
    },
  })

  const {
    bootstrap,
    streaming,
    streamingReasoning,
    runActivities,
    resetStreaming,
    pendingApprovals,
    clearPendingApproval,
    restorePendingApproval,
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
    resetWorkspaceFiles: guardedResetWorkspaceFiles,
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

  // 终端管理器单例：接线一次事件订阅（幂等守卫），并同步当前激活项目。
  useEffect(() => {
    terminalManager.init()
  }, [])

  useEffect(() => {
    terminalManager.setActiveProject(activeProjectId)
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
    beforeProjectClear: guardedResetWorkspaceFiles,
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
        guardDirtyBuffersThen={guardDirtyBuffersThen}
        reloadAllTextTabs={reloadAllTextTabs}
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
      <AppMain
        view={view}
        activeSessionId={activeSessionId}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        topBar={{
          sidebarOpen,
          onToggleSidebar: () => setSidebarOpen((open) => !open),
          runtimeState: bootstrap?.state ?? '',
          statusLabel,
        }}
        chat={{
          sessionData,
          delegations,
          streaming,
          streamingReasoning,
          runActivities,
          retryTick,
          hasEnabledProvider,
          permissionValue: permissionMode,
          onPermissionChange: changePermissionMode,
          modelOptions,
          selectedModelKey,
          onModelChange: setSelectedModelKey,
          skills,
          composerPrefill,
          onPrefillConsumed: () => setComposerPrefill(null),
          onSend: sendMessage,
          onStop: stopRun,
          onRetry: retryRun,
          onGoSettings: () => setView('settings'),
          pendingApprovals,
          onResolveApproval: handleResolveApproval,
          onResourceClick: handleResourceClick,
          onOpenDiff: openDiff,
        }}
        landing={{
          project: activeProject,
          projects,
          selectedProjectId: activeProjectId,
          onProjectChange: selectLandingProject,
          sessions: activeProject ? projectSessions : [],
          hasEnabledProvider,
          permissionValue: permissionMode,
          onPermissionChange: changePermissionMode,
          modelOptions,
          selectedModelKey,
          onModelChange: setSelectedModelKey,
          skills,
          composerPrefill,
          onPrefillConsumed: () => setComposerPrefill(null),
          onSend: sendMessage,
          onSelectSession: openSession,
          onRenameSession: renameSession,
          onDeleteSession: deleteSession,
          onGoSettings: () => setView('settings'),
        }}
        settings={{
          profiles,
          onSaved: refreshProfiles,
          onBackToChat: () => setView('chat'),
          confirm,
        }}
        instructions={{ confirm }}
        onUseSkill={async (skillId, sessionId) => {
          if (!(await guardedResetWorkspaceFiles())) return
          setActiveProjectId(null)
          setActiveSessionId(sessionId)
          void refreshSessionData(sessionId)
          void refreshStandaloneSessions()
          setComposerPrefill({ skillId, nonce: Date.now() })
          setView('chat')
        }}
        workspace={{
          open: workspaceOpen,
          setOpen: setWorkspaceOpen,
          width: workspaceWidth,
          setWidth: setWorkspaceWidth,
          panel: {
            ref: filePanelRef,
            project: activeProject,
            systemReady: bootstrap?.systemReady ?? false,
            openTabs,
            activeTabId,
            dirtyPaths,
            onSelectTab: selectTab,
            onRequestCloseTab: requestCloseTab,
            onReorderTabs: reorderTabs,
            onDirtyChange: setTabDirty,
            confirm,
            onResourceClick: handleResourceClick,
            width: workspaceWidth,
          },
        }}
        terminal={{
          open: terminalOpen,
          onToggle: handleToggleTerminal,
          activeProjectId,
          confirm,
        }}
      />
      <ConfirmDialog
        state={confirmState}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        onTertiary={handleTertiary}
      />
      <ToastHost />
    </div>
  )
}
