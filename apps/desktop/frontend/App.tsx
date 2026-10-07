import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ProviderProfile,
  Project,
  Session,
  Delegation,
  UserQuestionAnswer,
} from '@reflexion-os-studio/runtime-client'
import { ReadyApp } from './components/ReadyApp'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import { useModelSelection } from './hooks/useModelSelection'
import { usePermissionPreset } from './hooks/permissions/usePermissionPreset'
import { useAdvancedPermissions } from './hooks/permissions/useAdvancedPermissions'
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
import { showToast } from './components/Toast'
import { STATUS_LABELS } from './components/TopBar'
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
  } = useWorkspacePanel(activeProjectId)
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
  const skills = useSkillCatalog(runtimeReady, activeProjectId)
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

  if (!runtimeReady || bootstrap === null) {
    return (
      <BootstrapScreen
        status={statusLabel}
        detail={bootstrap?.detail ?? 'M0 Bootstrap'}
      />
    )
  }

  return (
    <ReadyApp
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      sidebarMode={sidebarMode}
      setSidebarMode={setSidebarMode}
      sidebarWidth={sidebarWidth}
      setSidebarWidth={setSidebarWidth}
      projects={projects}
      projectSessions={projectSessions}
      standaloneSessions={standaloneSessions}
      activeProject={activeProject}
      activeProjectId={activeProjectId}
      setActiveProjectId={setActiveProjectId}
      activeSessionId={activeSessionId}
      setActiveSessionId={setActiveSessionId}
      sessionData={sessionData}
      setSessionData={setSessionData}
      delegations={delegations}
      creatingProject={creatingProject}
      view={view}
      setView={setView}
      notice={notice}
      setNotice={setNotice}
      bootstrap={bootstrap}
      statusLabel={statusLabel}
      profiles={profiles}
      skills={skills}
      agentTemplates={agentTemplates}
      hasEnabledProvider={hasEnabledProvider}
      permissionPreset={permissionPreset}
      changePermissionPreset={changePermissionPreset}
      approvalOverride={approvalOverride}
      changeApprovalOverride={changeApprovalOverride}
      dangerLease={dangerLease}
      disableDanger={disableDanger}
      dangerDialogOpen={dangerDialogOpen}
      setDangerDialogOpen={setDangerDialogOpen}
      modelOptions={modelOptions}
      selectedModelKey={selectedModelKey}
      setSelectedModelKey={setSelectedModelKey}
      composerPrefill={composerPrefill}
      setComposerPrefill={setComposerPrefill}
      streaming={streaming}
      streamingReasoning={streamingReasoning}
      runActivities={runActivities}
      pendingApprovals={pendingApprovals}
      pendingInteractions={pendingInteractions}
      runningSessionIds={runningSessionIds}
      completedSessionIds={completedSessionIds}
      failedSessionIds={failedSessionIds}
      approvalSessionIds={approvalSessionIds}
      workspaceOpen={workspaceOpen}
      setWorkspaceOpen={setWorkspaceOpen}
      workspaceWidth={workspaceWidth}
      setWorkspaceWidth={setWorkspaceWidth}
      openTabs={openTabs}
      activeTabId={activeTabId}
      activeFilePath={activeFilePath}
      filesFocusAssetId={filesFocusAssetId}
      setFilesFocusAssetId={setFilesFocusAssetId}
      dirtyPaths={dirtyPaths}
      filePanelRef={filePanelRef}
      terminalOpen={terminalOpen}
      toggleTerminal={toggleTerminal}
      confirm={confirm}
      confirmState={confirmState}
      handleConfirm={handleConfirm}
      handleTertiary={handleTertiary}
      handleCancel={handleCancel}
      openFile={openFile}
      openDiff={openDiff}
      selectTab={selectTab}
      requestCloseTab={requestCloseTab}
      reorderTabs={reorderTabs}
      setTabDirty={setTabDirty}
      guardDirtyBuffersThen={guardDirtyBuffersThen}
      guardedResetWorkspaceFiles={guardedResetWorkspaceFiles}
      reloadAllTextTabs={reloadAllTextTabs}
      refreshSessionData={refreshSessionData}
      refreshStandaloneSessions={refreshStandaloneSessions}
      refreshProfiles={refreshProfiles}
      enterProjectFiles={enterProjectFiles}
      backToChat={backToChat}
      selectProject={selectProject}
      selectLandingProject={selectLandingProject}
      openSession={openSession}
      newStandaloneChat={newStandaloneChat}
      createProject={createProject}
      deleteProject={deleteProject}
      renameSession={renameSession}
      deleteSession={deleteSession}
      handleSelectSession={handleSelectSession}
      handleSelectStandaloneSession={handleSelectStandaloneSession}
      sendMessage={sendMessage}
      editResendMessage={editResendMessage}
      stopRun={stopRun}
      retryRun={retryRun}
      handleResolveApproval={handleResolveApproval}
      handleInteractionSubmit={handleInteractionSubmit}
      handleResourceClick={handleResourceClick}
    />
  )
}
