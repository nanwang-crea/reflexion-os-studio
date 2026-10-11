import { setSessionExecutionMode } from '../api/sessions'
import { AppShell } from './AppShell'
import type { ReadyAppProps } from './ready-app-props'

/** 运行时就绪后的界面装配；状态仍由 App 持有。 */
export function ReadyApp(props: ReadyAppProps): React.JSX.Element {
  return (
    <AppShell
      sidebarWidth={props.sidebarWidth}
      setSidebarWidth={props.setSidebarWidth}
      sidebar={{
        open: props.sidebarOpen,
        mode: props.sidebarMode,
        projects: props.projects,
        projectSessions: props.projectSessions,
        standaloneSessions: props.standaloneSessions,
        activeProjectId: props.activeProjectId,
        activeSessionId: props.activeSessionId,
        runningSessionIds: props.runningSessionIds,
        completedSessionIds: props.completedSessionIds,
        failedSessionIds: props.failedSessionIds,
        approvalSessionIds: props.approvalSessionIds,
        creatingProject: props.creatingProject,
        view: props.view,
        systemReady: props.bootstrap.systemReady,
        activeFilePath: props.openTabs.length > 0 ? props.activeFilePath : null,
        focusAssetId: props.filesFocusAssetId,
        onFocusConsumed: () => props.setFilesFocusAssetId(null),
        onOpenFile: props.openFile,
        onOpenDiff: props.openDiff,
        guardDirtyBuffersThen: props.guardDirtyBuffersThen,
        reloadAllTextTabs: props.reloadAllTextTabs,
        onEnterProjectFiles: props.enterProjectFiles,
        onBackToChat: props.backToChat,
        onSelectProject: props.selectProject,
        onSelectSession: props.handleSelectSession,
        onSelectStandaloneSession: props.handleSelectStandaloneSession,
        onNewSessionInProject: props.selectProject,
        onNewChat: props.newStandaloneChat,
        onCreateProject: props.createProject,
        onDeleteProject: props.deleteProject,
        onRenameSession: props.renameSession,
        onDeleteSession: props.deleteSession,
        onSelectView: (nextView) => {
          props.setView((current) => (current === nextView ? 'chat' : nextView))
        },
      }}
      main={{
        view: props.view,
        activeSessionId: props.activeSessionId,
        notice: props.notice,
        onDismissNotice: () => props.setNotice(null),
        topBar: {
          sidebarOpen: props.sidebarOpen,
          onToggleSidebar: () => props.setSidebarOpen((open) => !open),
          runtimeState: props.bootstrap.state,
          statusLabel: props.statusLabel,
        },
        chat: {
          sessionData: props.sessionData,
          onLoadOlder: props.loadOlderHistory,
          delegations: props.delegations,
          streaming: props.streaming,
          streamingReasoning: props.streamingReasoning,
          runActivities: props.runActivities,
          hasEnabledProvider: props.hasEnabledProvider,
          permissionValue: props.permissionPreset,
          onPermissionChange: props.changePermissionPreset,
          advanced: {
            approvalOverride: props.approvalOverride,
            onApprovalOverrideChange: (value) => {
              void props.changeApprovalOverride(value)
            },
            dangerActive: props.dangerLease !== null,
            onOpenDanger: () => props.setDangerDialogOpen(true),
          },
          dangerLease: props.dangerLease,
          onDisableDanger: () => {
            void props.disableDanger()
          },
          modelOptions: props.modelOptions,
          reasoningSelection: props.reasoningSelection,
          selectedModelKey: props.selectedModelKey,
          onModelChange: props.setSelectedModelKey,
          skills: props.skills,
          agentTemplates: props.agentTemplates,
          composerPrefill: props.composerPrefill,
          onPrefillConsumed: () => props.setComposerPrefill(null),
          onSend: props.sendMessage,
          onEditResend: props.editResendMessage,
          onStop: props.stopRun,
          onRetry: props.retryRun,
          onGoSettings: () => props.setView('settings'),
          onExecutionModeChange: async (mode) => {
            if (!props.activeSessionId) return
            const result = await setSessionExecutionMode(
              props.activeSessionId,
              mode,
            )
            props.setSessionData((current) =>
              current === null
                ? current
                : { ...current, session: result.session },
            )
          },
          pendingApprovals: props.pendingApprovals,
          onResolveApproval: props.handleResolveApproval,
          pendingInteractions: props.pendingInteractions,
          onInteractionSubmit: async (interactionId, answers) => {
            try {
              return await props.handleInteractionSubmit(interactionId, answers)
            } catch (error) {
              props.setNotice(
                error instanceof Error ? error.message : String(error),
              )
              return false
            }
          },
          onResourceClick: props.handleResourceClick,
          onOpenDiff: props.openDiff,
        },
        landing: {
          project: props.activeProject,
          projects: props.projects,
          selectedProjectId: props.activeProjectId,
          onProjectChange: props.selectLandingProject,
          sessions: props.activeProject ? props.projectSessions : [],
          hasEnabledProvider: props.hasEnabledProvider,
          permissionValue: props.permissionPreset,
          onPermissionChange: props.changePermissionPreset,
          modelOptions: props.modelOptions,
          reasoningSelection: props.reasoningSelection,
          selectedModelKey: props.selectedModelKey,
          onModelChange: props.setSelectedModelKey,
          skills: props.skills,
          agentTemplates: props.agentTemplates,
          composerPrefill: props.composerPrefill,
          onPrefillConsumed: () => props.setComposerPrefill(null),
          onSend: props.sendMessage,
          onSelectSession: props.openSession,
          onRenameSession: props.renameSession,
          onDeleteSession: props.deleteSession,
          onGoSettings: () => props.setView('settings'),
        },
        settings: {
          profiles: props.profiles,
          onSaved: props.refreshProfiles,
          onBackToChat: () => props.setView('chat'),
          confirm: props.confirm,
        },
        instructions: { confirm: props.confirm },
        onUseSkill: async (skillId, sessionId) => {
          if (!(await props.guardedResetWorkspaceFiles())) return
          props.setActiveProjectId(null)
          props.setActiveSessionId(sessionId)
          void props.refreshSessionData(sessionId)
          void props.refreshStandaloneSessions()
          props.setComposerPrefill({ skillId, nonce: Date.now() })
          props.setView('chat')
        },
        workspace: {
          open: props.workspaceOpen,
          setOpen: props.setWorkspaceOpen,
          width: props.workspaceWidth,
          setWidth: props.setWorkspaceWidth,
          panel: {
            ref: props.filePanelRef,
            project: props.activeProject,
            systemReady: props.bootstrap.systemReady,
            openTabs: props.openTabs,
            activeTabId: props.activeTabId,
            dirtyPaths: props.dirtyPaths,
            onSelectTab: props.selectTab,
            onRequestCloseTab: props.requestCloseTab,
            onReorderTabs: props.reorderTabs,
            onDirtyChange: props.setTabDirty,
            confirm: props.confirm,
            onResourceClick: props.handleResourceClick,
            width: props.workspaceWidth,
          },
        },
        terminal: {
          open: props.terminalOpen,
          onToggle: props.toggleTerminal,
          activeProjectId: props.activeProjectId,
          confirm: props.confirm,
        },
      }}
      danger={{
        open: props.dangerDialogOpen,
        sessionId: props.activeSessionId,
        onClose: () => props.setDangerDialogOpen(false),
        onEnabled: () => props.setDangerDialogOpen(false),
      }}
      confirm={{
        state: props.confirmState,
        onConfirm: props.handleConfirm,
        onCancel: props.handleCancel,
        onTertiary: props.handleTertiary,
      }}
    />
  )
}
