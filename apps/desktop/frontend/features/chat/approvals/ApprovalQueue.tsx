import { useState } from 'react'
import type { PendingApproval } from '../../../hooks/permissions/usePendingApprovals'
import { presentApproval } from './approval-presenter'
import { ApprovalCard } from './ApprovalCard'

/**
 * 当前会话审批队列：按 approval.required 到达顺序展示，一次只展开队首；
 * 其余折叠为"还有 N 项待审批"（可展开看摘要，不改变队首焦点）。
 * 顺序由接收顺序决定，前端不重排、不把 choice 复用到多个审批。
 */
export function ApprovalQueue({
  approvals,
  onChoose,
}: {
  approvals: PendingApproval[]
  onChoose: (toolCallId: string, choiceId: string) => void
}): React.JSX.Element | null {
  const [showRest, setShowRest] = useState(false)
  if (approvals.length === 0) return null
  const [head, ...rest] = approvals
  return (
    <div className="approval-queue">
      <ApprovalCard
        // 队首切换必须换组件实例：提交态（busy）残留会让下一张卡点不动。
        key={head.toolCallId}
        approval={head}
        focusable
        onChoose={onChoose}
      />
      {rest.length > 0 && (
        <div className="approval-queue-rest">
          <button
            type="button"
            className="ghost approval-queue-toggle"
            aria-expanded={showRest}
            onClick={() => setShowRest((open) => !open)}
          >
            还有 {rest.length} 项待审批
          </button>
          {showRest && (
            <ul className="approval-queue-summary" aria-label="其余待审批项">
              {rest.map((entry) => {
                const display = presentApproval(entry)
                return (
                  <li key={entry.toolCallId}>
                    <span
                      className={`queue-risk risk-${display.risk}`}
                      aria-hidden
                    >
                      •
                    </span>
                    {display.actionLabel}
                    {display.subject && (
                      <code className="queue-subject">
                        {display.subject.value.slice(0, 60)}
                      </code>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
