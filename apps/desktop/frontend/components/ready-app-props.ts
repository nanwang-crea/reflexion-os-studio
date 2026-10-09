import type { ComponentProps, Dispatch, RefObject, SetStateAction } from 'react'
import type {
  Delegation,
  Project,
  ProviderProfile,
  Session,
} from '@reflexion-os-studio/runtime-client'
import type { SessionData } from '../api/sessions'
import type { FileViewerPanelHandle } from '../features/workspace/files/FileViewerPanel'
import type { ViewName } from '../hooks/session/useSessionNavigation'
import type { BootstrapSnapshot } from '../hooks/useAppBootstrap'
import type { ConfirmDialogHandle } from '../hooks/useConfirmDialog'
import type { SidebarMode } from '../hooks/useSidebarPanel'
import type { WorkspacePanelState } from '../hooks/workspace/useWorkspacePanel'
import type { AppMain } from '../AppMain'
import type { Sidebar } from './Sidebar'

type MainProps = ComponentProps<typeof AppMain>
type SidebarProps = ComponentProps<typeof Sidebar>
type Panel = WorkspacePanelState

export interface ReadyAppProps {
  sidebarOpen: boolean
  setSidebarOpen: Dispatch<SetStateAction<boolean>>
  sidebarMode: SidebarMode
  setSidebarMode: Dispatch<SetStateAction<SidebarMode>>
  sidebarWidth: number
  setSidebarWidth: Dispatch<SetStateAction<number>>
  projects: Project[]
  projectSessions: Session[]
  standaloneSessions: Session[]
  activeProject: Project | null
  activeProjectId: string | null
  setActiveProjectId: Dispatch<SetStateAction<string | null>>
  activeSessionId: string | null
  setActiveSessionId: Dispatch<SetStateAction<string | null>>
  sessionData: SessionData | null
  setSessionData: Dispatch<SetStateAction<SessionData | null>>
  delegations: Delegation[]
  creatingProject: boolean
  view: ViewName
  setView: Dispatch<SetStateAction<ViewName>>
  notice: string | null
  setNotice: Dispatch<SetStateAction<string | null>>
  bootstrap: BootstrapSnapshot
  statusLabel: string
  profiles: ProviderProfile[]
  skills: MainProps['chat']['skills']
  agentTemplates: MainProps['chat']['agentTemplates']
  hasEnabledProvider: boolean
  permissionPreset: MainProps['chat']['permissionValue']
  changePermissionPreset: MainProps['chat']['onPermissionChange']
  approvalOverride: MainProps['chat']['advanced']['approvalOverride']
  changeApprovalOverride: (
    value: MainProps['chat']['advanced']['approvalOverride'],
  ) => void
  dangerLease: MainProps['chat']['dangerLease']
  disableDanger: () => void
  dangerDialogOpen: boolean
  setDangerDialogOpen: (open: boolean) => void
  modelOptions: MainProps['chat']['modelOptions']
  selectedModelKey: MainProps['chat']['selectedModelKey']
  setSelectedModelKey: MainProps['chat']['onModelChange']
  composerPrefill: { skillId: string; nonce: number } | null
  setComposerPrefill: Dispatch<
    SetStateAction<{ skillId: string; nonce: number } | null>
  >
  streaming: MainProps['chat']['streaming']
  streamingReasoning: MainProps['chat']['streamingReasoning']
  runActivities: MainProps['chat']['runActivities']
  pendingApprovals: MainProps['chat']['pendingApprovals']
  pendingInteractions: MainProps['chat']['pendingInteractions']
  runningSessionIds: SidebarProps['runningSessionIds']
  completedSessionIds: SidebarProps['completedSessionIds']
  failedSessionIds: SidebarProps['failedSessionIds']
  approvalSessionIds: SidebarProps['approvalSessionIds']
  workspaceOpen: boolean
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>
  workspaceWidth: number
  setWorkspaceWidth: Dispatch<SetStateAction<number>>
  openTabs: Panel['openTabs']
  activeTabId: Panel['activeTabId']
  activeFilePath: Panel['activeFilePath']
  filesFocusAssetId: Panel['filesFocusAssetId']
  setFilesFocusAssetId: Panel['setFilesFocusAssetId']
  dirtyPaths: Panel['dirtyPaths']
  filePanelRef: RefObject<FileViewerPanelHandle | null>
  terminalOpen: boolean
  toggleTerminal: () => void
  confirm: ConfirmDialogHandle['confirm']
  confirmState: ConfirmDialogHandle['confirmState']
  handleConfirm: ConfirmDialogHandle['handleConfirm']
  handleTertiary: ConfirmDialogHandle['handleTertiary']
  handleCancel: ConfirmDialogHandle['handleCancel']
  openFile: Panel['openFile']
  openDiff: Panel['openDiff']
  selectTab: Panel['selectTab']
  requestCloseTab: (tabId: string) => Promise<void>
  reorderTabs: (ids: string[]) => void
  setTabDirty: Panel['setTabDirty']
  guardDirtyBuffersThen: () => Promise<boolean>
  guardedResetWorkspaceFiles: () => Promise<boolean>
  reloadAllTextTabs: Panel['reloadAllTextTabs']
  loadOlderHistory: (
    sessionId: string,
    before: import('@reflexion-os-studio/runtime-client').HistoryCursor,
  ) => Promise<void>
  refreshSessionData: (sessionId: string) => Promise<void>
  refreshStandaloneSessions: () => Promise<void>
  refreshProfiles: () => Promise<void>
  enterProjectFiles: (projectId: string) => void
  backToChat: () => void
  selectProject: (projectId: string) => void
  selectLandingProject: (projectId: string | null) => void
  openSession: (sessionId: string) => void
  newStandaloneChat: () => void
  createProject: () => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  handleSelectSession: (sessionId: string) => void
  handleSelectStandaloneSession: (sessionId: string) => void
  sendMessage: MainProps['chat']['onSend']
  editResendMessage: MainProps['chat']['onEditResend']
  stopRun: MainProps['chat']['onStop']
  retryRun: MainProps['chat']['onRetry']
  handleResolveApproval: MainProps['chat']['onResolveApproval']
  handleInteractionSubmit: (
    interactionId: string,
    answers: Parameters<MainProps['chat']['onInteractionSubmit']>[1],
  ) => Promise<boolean>
  handleResourceClick: MainProps['chat']['onResourceClick']
}
