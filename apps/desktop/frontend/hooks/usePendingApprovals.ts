import { useCallback, useRef, useState } from 'react'
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'

/**
 * 等待用户审批的工具调用（approval.required → approval.resolved 之间可见）。
 * 载荷字段从 contracts 事件类型派生（权限模型 V2：subject/risk/context/
 * choices），不手写平行类型；信封字段另行剥离，runId 为前端消费所需。
 */
type ApprovalRequiredPayload = Omit<
  Extract<RuntimeEvent, { type: 'approval.required' }>,
  | 'type'
  | 'protocolVersion'
  | 'eventId'
  | 'scope'
  | 'seq'
  | 'occurredAt'
  | 'runId'
>

export interface PendingApproval extends ApprovalRequiredPayload {
  runId: string
}

/** 审批等待队列：bootstrap 事件回调驱动（approval.required / resolved）。 */
export function usePendingApprovals(): {
  pendingApprovals: PendingApproval[]
  onApprovalRequired: (entry: PendingApproval) => void
  onApprovalResolved: (toolCallId: string) => void
  /** 审批命令失败时按原队列位置恢复整条 PendingApproval（协议数据不丢）。 */
  restorePending: (entry: PendingApproval) => void
  /** Run 终态时清理该 Run 遗留的审批等待（取消/失败路径的兜底）。 */
  clearForRun: (runId: string) => void
} {
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  )
  // 摘除时的队列位置：失败恢复要回到原位（审批语义与顺序相关，不重排）。
  const positions = useRef(new Map<string, number>())
  const onApprovalRequired = useCallback((entry: PendingApproval): void => {
    setPendingApprovals((pending) => [
      ...pending.filter((item) => item.toolCallId !== entry.toolCallId),
      entry,
    ])
  }, [])
  const onApprovalResolved = useCallback((toolCallId: string): void => {
    setPendingApprovals((pending) => {
      const index = pending.findIndex((item) => item.toolCallId === toolCallId)
      if (index >= 0) positions.current.set(toolCallId, index)
      return pending.filter((item) => item.toolCallId !== toolCallId)
    })
  }, [])
  const restorePending = useCallback((entry: PendingApproval): void => {
    const remembered = positions.current.get(entry.toolCallId)
    setPendingApprovals((pending) => {
      if (pending.some((item) => item.toolCallId === entry.toolCallId)) {
        return pending
      }
      const next = [...pending]
      const at = Math.min(remembered ?? next.length, next.length)
      next.splice(at, 0, entry)
      return next
    })
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
    restorePending,
    clearForRun,
  }
}
