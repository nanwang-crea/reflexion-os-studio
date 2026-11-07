import type { ApprovalDisplay } from './approval-presenter'
import { AlertIcon, ShieldIcon } from '../../../ui/icons'

/** 审批卡头部：状态图标 + 风险标题 + 操作名（图标旁必有文字，不靠颜色表意）。 */
export function ApprovalHeader({
  display,
  id,
}: {
  display: ApprovalDisplay
  id: string
}): React.JSX.Element {
  const agent = display.context?.agent
  return (
    <div className="approval-head" id={id}>
      <span className={`approval-risk-icon risk-${display.risk}`} aria-hidden>
        {display.risk === 'normal' ? <ShieldIcon /> : <AlertIcon size={16} />}
      </span>
      <span className="approval-title">
        {agent !== undefined && agent.depth > 0 && (
          <span className="agent-source">
            {agent.displayName} · 子 Agent · 第 {agent.depth} 层
          </span>
        )}
        {display.actionLabel}
        {agent !== undefined && agent.depth > 0 && display.context !== null && (
          <span className="agent-permission-badge">
            {display.context.permissionPreset === 'workspace-full'
              ? '完全允许'
              : display.context.permissionPreset === 'workspace-write'
                ? '工作区可写'
                : '工作区只读'}
          </span>
        )}
      </span>
      <span className="approval-risk-label">{display.riskTitle}</span>
    </div>
  )
}
