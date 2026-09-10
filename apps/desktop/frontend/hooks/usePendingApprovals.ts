import { useCallback, useState } from 'react'

/** 等待用户审批的工具调用（approval.required → approval.resolved 之间可见）。 */
export interface PendingApproval {
  toolCallId: string
  runId: string
  /** 审批所属会话：侧栏会话行据此显示待审批标记（旧版事件可缺省）。 */
  sessionId?: string
  operation: string
  summary: string
}

/** 审批等待队列：bootstrap 事件回调驱动（approval.required / resolved）。 */
export function usePendingApprovals(): {
  pendingApprovals: PendingApproval[]
  onApprovalRequired: (entry: PendingApproval) => void
  onApprovalResolved: (toolCallId: string) => void
  /** Run 终态时清理该 Run 遗留的审批等待（取消/失败路径的兜底）。 */
  clearForRun: (runId: string) => void
} {
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  )
  const onApprovalRequired = useCallback((entry: PendingApproval): void => {
    setPendingApprovals((pending) => [
      ...pending.filter((item) => item.toolCallId !== entry.toolCallId),
      entry,
    ])
  }, [])
  const onApprovalResolved = useCallback((toolCallId: string): void => {
    setPendingApprovals((pending) =>
      pending.filter((item) => item.toolCallId !== toolCallId),
    )
  }, [])
  const clearForRun = useCallback((runId: string): void => {
    setPendingApprovals((pending) =>
      pending.filter((entry) => entry.runId !== runId),
    )
  }, [])
  return {
    pendingApprovals,
    onApprovalRequired,
    onApprovalResolved,
    clearForRun,
  }
}
