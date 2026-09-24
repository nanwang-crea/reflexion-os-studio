import { useEffect, useRef, useState } from 'react'
import type { PendingApproval } from '../../../hooks/permissions/usePendingApprovals'
import { presentApproval } from './approval-presenter'
import { ApprovalHeader } from './ApprovalHeader'
import { ApprovalDetails } from './ApprovalDetails'
import { ApprovalActions } from './ApprovalActions'

/**
 * 单条普通审批卡（一个明确问题 + Runtime 认可的有限选择）。
 * 提交态由外部乐观摘卡驱动：onChoose 触发后本地禁用按钮防止重复点击，
 * 命令失败时上层恢复整条 PendingApproval（含 subject/choices）。
 *
 * 调用契约（见 ApprovalQueue）：必须以 approval.toolCallId 作为 React key。
 * 换审批项即换组件实例，submitted 随旧实例卸载自然归零——这是提交态重置的
 * 唯一机制，不得再用 effect 依赖 approval.toolCallId 补一层"双保险"：
 * effect 在 paint 之后才跑，挡不住复用那一帧的 busy，也违反"禁止把重跑
 * effect 当作状态同步手段"（AGENTS.md §11）。
 */
export function ApprovalCard({
  approval,
  onChoose,
  focusable,
}: {
  approval: PendingApproval
  onChoose: (toolCallId: string, choiceId: string) => void
  /** 队首卡挂载时聚焦容器（不直接聚焦"允许一次"，防误触回车批准）。 */
  focusable: boolean
}): React.JSX.Element {
  const display = presentApproval(approval)
  const [submitted, setSubmitted] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const titleId = `approval-title-${approval.toolCallId}`
  const descId = `approval-desc-${approval.toolCallId}`

  useEffect(() => {
    if (focusable) containerRef.current?.focus()
  }, [focusable, approval.toolCallId])

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={`approval-card risk-${display.risk}`}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
    >
      <ApprovalHeader display={display} id={titleId} />
      <ApprovalDetails display={display} descriptionId={descId} />
      <ApprovalActions
        display={display}
        busyLabel={submitted}
        onChoose={(choiceId) => {
          if (submitted !== null) return
          setSubmitted(choiceId)
          onChoose(approval.toolCallId, choiceId)
        }}
      />
    </div>
  )
}
