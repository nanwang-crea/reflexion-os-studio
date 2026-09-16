import type { ApprovalDisplay } from './approval-presenter'

const RISK_ICONS: Record<ApprovalDisplay['risk'], string> = {
  normal: 'ⓘ',
  warning: '⚠',
  elevated: '⚠',
  'danger-confirm': '☠',
}

/** 审批卡头部：状态图标 + 风险标题 + 操作名（图标旁必有文字，不靠颜色表意）。 */
export function ApprovalHeader({
  display,
  id,
}: {
  display: ApprovalDisplay
  id: string
}): React.JSX.Element {
  return (
    <div className="approval-head" id={id}>
      <span className={`approval-risk-icon risk-${display.risk}`} aria-hidden>
        {RISK_ICONS[display.risk]}
      </span>
      <span className="approval-title">
        Agent 请求{display.actionLabel}
        <span className="approval-risk-label"> · {display.riskTitle}</span>
      </span>
    </div>
  )
}
