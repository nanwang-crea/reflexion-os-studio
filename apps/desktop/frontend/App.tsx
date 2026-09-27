import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProviderProfile,
  Project,
  Session,
  Delegation,
  UserQuestionAnswer,
} from '@reflexion-os-studio/runtime-client'
import { AppMain } from './AppMain'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import { useModelSelection } from './hooks/useModelSelection'
import { usePermissionPreset } from './hooks/permissions/usePermissionPreset'
import { useAdvancedPermissions } from './hooks/permissions/useAdvancedPermissions'
import { DangerConfirmationDialog } from './features/chat/approvals/DangerConfirmationDialog'
import { useSidebarPanel } from './hooks/useSidebarPanel'
import { useWorkspacePanel } from './hooks/workspace/useWorkspacePanel'
import { useConfirmDialog } from './hooks/useConfirmDialog'
import { useDataRefreshers } from './hooks/useDataRefreshers'
import {
  useSessionNavigation,
  type ViewName,
} from './hooks/session/useSessionNavigation'
import { useApprovalResolution } from './hooks/permissions/useApprovalResolution'
import type { SessionData } from './api/sessions'
import { ConfirmDialog } from './components/ConfirmDialog'
import { showToast, ToastHost } from './components/Toast'
import { ResizeHandle } from './components/ResizeHandle'
import { STATUS_LABELS } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import type { FileViewerPanelHandle } from './features/workspace/files/FileViewerPanel'
import { useWorkspaceTabGuard } from './hooks/workspace/useWorkspaceTabGuard'
import { useAppHotkeys } from './hooks/useAppHotkeys'
import { useSessionActions } from './hooks/session/useSessionActions'
import { useResourceRouter } from './hooks/useResourceRouter'
import {
  useAgentTemplateCatalog,
  useSkillCatalog,
  useTerminalSurface,
} from './hooks/useAppSurfaces'
import { BootstrapScreen } from './components/BootstrapScreen'
import { respondToInteraction } from './api/chat'
import { setSessionExecutionMode } from './api/sessions'

export default function App() {
  const [view, setView] = useState<ViewName>('chat')
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
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
  const { terminalOpen, toggleTerminal } = useTerminalSurface(activeProjectId)
  const { permissionPreset, changePermissionPreset } = usePermissionPreset()
  const {
    approvalOverride,
    changeApprovalOverride,
    dangerLease,
    onDangerChanged,
    disableDanger,
    dangerDialogOpen,
    setDangerDialogOpen,
  } = useAdvancedPermissions(activeSessionId, setNotice)
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
      onDangerChanged,
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
      onDangerChanged,
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
    pendingInteractions,
    clearPendingApproval,
    restorePendingApproval,
    removePendingInteraction,
    runningSessionIds,
    completedSessionIds,
    failedSessionIds,
    approvalSessionIds,
    clearSessionStatus,
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

  const handleResolveApproval = useApprovalResolution({
    pendingApprovals,
    clearPendingApproval,
    restorePendingApproval,
    setNotice,
  })
  const handleInteractionSubmit = useCallback(
    async (interactionId: string, answers: UserQuestionAnswer[]) => {
      const result = await respondToInteraction({ interactionId, answers })
      if (!result.accepted) {
        setNotice('该问题已失效或答案无效，请等待 Agent 重新提问')
        return false
      }
      removePendingInteraction(interactionId)
      return true
    },
    [removePendingInteraction],
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
    editResendMessage,
    stopRun,
    retryRun,
  } = useSessionActions({
    projects,
    activeSessionId,
    activeProjectId,
    selectedModelKey,
    sessionData,
    permissionPreset,
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
  const skills = useSkillCatalog(runtimeReady)
  const agentTemplates = useAgentTemplateCatalog(runtimeReady, view)
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null

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
      <BootstrapScreen
        status={statusLabel}
        detail={bootstrap?.detail ?? 'M0 Bootstrap'}
      />
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
          hasEnabledProvider,
          permissionValue: permissionPreset,
          onPermissionChange: changePermissionPreset,
          advanced: {
            approvalOverride,
            onApprovalOverrideChange: (value) => {
              void changeApprovalOverride(value)
            },
            dangerActive: dangerLease !== null,
            onOpenDanger: () => setDangerDialogOpen(true),
          },
          dangerLease,
          onDisableDanger: () => {
            void disableDanger()
          },
          modelOptions,
          selectedModelKey,
          onModelChange: setSelectedModelKey,
          skills,
          agentTemplates,
          composerPrefill,
          onPrefillConsumed: () => setComposerPrefill(null),
          onSend: sendMessage,
          onEditResend: editResendMessage,
          onStop: stopRun,
          onRetry: retryRun,
          onGoSettings: () => setView('settings'),
          onExecutionModeChange: async (mode) => {
            if (!activeSessionId) return
            const result = await setSessionExecutionMode(activeSessionId, mode)
            setSessionData((current) =>
              current === null
                ? current
                : { ...current, session: result.session },
            )
          },
          pendingApprovals,
          onResolveApproval: handleResolveApproval,
          pendingInteractions,
          onInteractionSubmit: async (interactionId, answers) => {
            try {
              return await handleInteractionSubmit(interactionId, answers)
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error))
              return false
            }
          },
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
          permissionValue: permissionPreset,
          onPermissionChange: changePermissionPreset,
          modelOptions,
          selectedModelKey,
          onModelChange: setSelectedModelKey,
          skills,
          agentTemplates,
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
          onToggle: toggleTerminal,
          activeProjectId,
          confirm,
        }}
      />
      <DangerConfirmationDialog
        open={dangerDialogOpen}
        sessionId={activeSessionId}
        onClose={() => setDangerDialogOpen(false)}
        onEnabled={() => setDangerDialogOpen(false)}
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
