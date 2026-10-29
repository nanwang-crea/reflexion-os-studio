import { ChatView } from '../chat/ChatView'
import { OperationHost } from '../../components/operations/OperationHost'
import { useRemoteSession } from './useRemoteSession'
import { useRemoteActions } from './useRemoteActions'
import type { ResourceLink } from '@reflexion-os-studio/runtime-client'
import type { RemoteCatalog } from '@reflexion-os-studio/contracts'
import type { Session } from '@reflexion-os-studio/runtime-client'
import { RemoteNavigation } from './RemoteNavigation'

export function RemoteChat({
  sessionId,
  projects,
  sessions,
  navigationOpen,
  onToggleNavigation,
  onSelectSession,
  onCreateSession,
  onBrowseFiles,
  onRefresh,
  onCloseNavigation,
  onOpenFile,
  onBack,
}: {
  sessionId: string
  projects: RemoteCatalog['projects']
  sessions: Session[]
  navigationOpen: boolean
  onToggleNavigation: () => void
  onSelectSession: (id: string) => void
  onCreateSession: (projectId: string | null) => void
  onBrowseFiles: (projectId: string) => void
  onRefresh: () => void
  onCloseNavigation: () => void
  onOpenFile: (projectId: string, path: string) => void
  onBack: () => void
}): React.JSX.Element {
  const state = useRemoteSession(sessionId)
  const actions = useRemoteActions(sessionId, state)
  const latestRun = state.data?.runs
    .filter((run) => run.supersededByRunId === null)
    .at(-1)
  const activeStatus =
    state.approvals.length > 0
      ? 'approval'
      : latestRun &&
          [
            'created',
            'running',
            'awaiting_approval',
            'awaiting_user_input',
          ].includes(latestRun.status)
        ? 'running'
        : latestRun?.status === 'failed'
          ? 'failed'
          : undefined
  return (
    <main className="remote-chat">
      <header className="remote-header">
        <button
          className="ghost remote-menu-button"
          onClick={onToggleNavigation}
          aria-label="打开会话导航"
        >
          ☰
        </button>
        <button className="ghost remote-back-button" onClick={onBack}>
          所有会话
        </button>
        <strong>{state.data?.session?.title ?? '电脑会话'}</strong>
        <span role="status">{state.connection}</span>
      </header>
      {navigationOpen && (
        <div className="remote-nav-scrim" onClick={onCloseNavigation}>
          <div onClick={(event) => event.stopPropagation()}>
            <RemoteNavigation
              projects={projects}
              sessions={sessions}
              activeSessionId={sessionId}
              onSelectSession={onSelectSession}
              onCreateSession={onCreateSession}
              onBrowseFiles={onBrowseFiles}
              onRefresh={onRefresh}
              onClose={onCloseNavigation}
              activeStatus={activeStatus}
            />
          </div>
        </div>
      )}
      {state.connection.includes('失效') && (
        <button className="ghost" onClick={() => location.reload()}>
          重新配对
        </button>
      )}
      {state.notice && (
        <div className="remote-notice" role="alert">
          {state.notice}
          <button className="ghost" onClick={() => state.setNotice(null)}>
            关闭
          </button>
        </div>
      )}
      <ChatView
        sessionData={state.data}
        onLoadOlder={state.loadOlder}
        delegations={state.delegations}
        streaming={state.streaming}
        streamingReasoning={state.streamingReasoning}
        runActivities={state.runActivities}
        hasEnabledProvider={actions.models.length > 0}
        permissionValue={actions.permission}
        onPermissionChange={actions.setPermission}
        dangerLease={state.dangerLease}
        onDisableDanger={actions.disableDanger}
        modelOptions={actions.models.map((item) => ({
          key: `${item.providerId}::${item.model}`,
          label: item.model,
          group: item.providerName,
        }))}
        selectedModelKey={actions.model}
        onModelChange={actions.setModel}
        skills={actions.skills}
        agentTemplates={actions.templates}
        onSend={actions.send}
        onEditResend={actions.edit}
        onStop={actions.stop}
        onRetry={actions.retry}
        onGoSettings={actions.settings}
        onExecutionModeChange={actions.executionMode}
        pendingApprovals={state.approvals}
        onResolveApproval={actions.choose}
        pendingInteractions={state.interactions}
        onInteractionSubmit={actions.answer}
        onResourceClick={(link: ResourceLink) => {
          if (link.kind === 'workspaceFile') {
            const projectId = link.projectId || state.data?.session?.projectId
            if (projectId) onOpenFile(projectId, link.path)
            else state.setNotice('独立会话没有关联项目，无法打开工作区文件')
          } else if (link.kind === 'externalUrl') {
            window.open(link.uri, '_blank', 'noopener,noreferrer')
          } else {
            state.setNotice('手机端暂不支持预览此资产')
          }
        }}
      />
      <OperationHost />
    </main>
  )
}
