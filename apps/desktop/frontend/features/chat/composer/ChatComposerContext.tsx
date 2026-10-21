import type { Plan } from '@reflexion-os-studio/runtime-client'
import type { ChatViewProps } from '../chat-view-types'
import { QueueBar } from '../QueueBar'
import { PlanCard } from '../run/PlanCard'
import { ApprovalQueue } from '../approvals/ApprovalQueue'
import { InteractionQueue } from '../interactions/InteractionQueue'

/** 计划、队列和确认内容独立滚动，给下方消息输入保留空间。 */
export function ChatComposerContext({
  view,
  plan,
  runActive,
  approvals,
  interactions,
}: {
  view: ChatViewProps
  plan: Plan | null
  runActive: boolean
  approvals: ChatViewProps['pendingApprovals']
  interactions: ChatViewProps['pendingInteractions']
}): React.JSX.Element {
  const session = view.sessionData?.session
  return (
    <div
      className="chat-composer-context"
      role="region"
      aria-label="会话待处理事项"
      tabIndex={0}
    >
      {!view.hasEnabledProvider && (
        <div className="inline-banner" role="status" aria-live="polite">
          <span>
            尚未配置模型 Provider：请先在设置中填写 API Key 后再开始对话。
          </span>
          <button type="button" className="ghost" onClick={view.onGoSettings}>
            去配置
          </button>
        </div>
      )}
      {session && (
        <QueueBar sessionId={session.id} agentTemplates={view.agentTemplates} />
      )}
      {plan && <PlanCard key={plan.id} plan={plan} />}
      {session?.executionMode === 'plan' && (
        <div className="plan-mode-banner" role="status">
          <span>计划模式 · 仅允许只读调研，批准计划后才能执行修改</span>
          <button
            type="button"
            className="ghost"
            disabled={runActive}
            title={runActive ? '运行中请通过计划审批退出' : '退出计划模式'}
            onClick={() => void view.onExecutionModeChange('execute')}
          >
            退出
          </button>
        </div>
      )}
      <ApprovalQueue approvals={approvals} onChoose={view.onResolveApproval} />
      <InteractionQueue
        onResourceClick={view.onResourceClick}
        interactions={interactions}
        onSubmit={view.onInteractionSubmit}
      />
    </div>
  )
}
