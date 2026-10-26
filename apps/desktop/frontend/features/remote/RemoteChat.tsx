import { ChatView } from '../chat/ChatView'
import { OperationHost } from '../../components/operations/OperationHost'
import { useRemoteSession } from './useRemoteSession'
import { useRemoteActions } from './useRemoteActions'

export function RemoteChat({
  sessionId,
  onBack,
}: {
  sessionId: string
  onBack: () => void
}): React.JSX.Element {
  const state = useRemoteSession(sessionId)
  const actions = useRemoteActions(sessionId, state)
  return (
    <main className="remote-chat">
      <header className="remote-header">
        <button className="ghost" onClick={onBack}>
          所有会话
        </button>
        <strong>{state.data?.session?.title ?? '电脑会话'}</strong>
        <span role="status">{state.connection}</span>
        <span>操作在电脑执行</span>
      </header>
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
      />
      <OperationHost />
    </main>
  )
}
