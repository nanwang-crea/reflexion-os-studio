import { useCallback, useRef, useState } from 'react'
import type { RuntimeEvent } from '@reflexion-os-studio/runtime-client'

/**
 * 等待用户审批的工具调用（approval.required → approval.resolved 之间可见）。
 * 载荷字段从 contracts 事件类型派生，保留前端归属匹配所需的 runId。
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

/** 审批等待队列；ref 同步接收事件，React state 只承载渲染快照。 */
export function usePendingApprovals(): {
  pendingApprovals: PendingApproval[]
  onApprovalRequired: (entry: PendingApproval) => void
  /** 乐观隐藏卡片，失败时仍可按原顺序恢复。 */
  removePending: (toolCallId: string) => void
  /** Runtime 已结算后彻底移除，迟到失败不可恢复。 */
  onApprovalResolved: (toolCallId: string) => void
  restorePending: (entry: PendingApproval) => void
  /** Run 终态清理可见及提交中的审批。 */
  clearForRun: (runId: string) => void
} {
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>(
    [],
  )
  // 乐观提交只隐藏条目，保留 Map 插入顺序；多个失败乱序返回也不会重排。
  // Runtime 结算或 Run 结束才删除，迟到失败无法恢复已删除的卡片。
  const queue = useRef(
    new Map<string, { entry: PendingApproval; hidden: boolean }>(),
  )
  const publish = useCallback((): void => {
    setPendingApprovals(
      [...queue.current.values()]
        .filter((item) => !item.hidden)
        .map((item) => item.entry),
    )
  }, [])

  const onApprovalRequired = useCallback(
    (entry: PendingApproval): void => {
      if (queue.current.get(entry.toolCallId)?.hidden) return
      queue.current.set(entry.toolCallId, { entry, hidden: false })
      publish()
    },
    [publish],
  )

  const removePending = useCallback(
    (toolCallId: string): void => {
      const item = queue.current.get(toolCallId)
      if (!item || item.hidden) return
      item.hidden = true
      publish()
    },
    [publish],
  )

  const onApprovalResolved = useCallback(
    (toolCallId: string): void => {
      if (queue.current.delete(toolCallId)) publish()
    },
    [publish],
  )

  const restorePending = useCallback(
    (entry: PendingApproval): void => {
      const item = queue.current.get(entry.toolCallId)
      if (!item?.hidden) return
      queue.current.set(entry.toolCallId, { entry, hidden: false })
      publish()
    },
    [publish],
  )

  const clearForRun = useCallback(
    (runId: string): void => {
      let changed = false
      for (const [toolCallId, item] of queue.current) {
        if (item.entry.runId === runId) {
          queue.current.delete(toolCallId)
          changed = true
        }
      }
      if (changed) publish()
    },
    [publish],
  )

  return {
    pendingApprovals,
    onApprovalRequired,
    removePending,
    onApprovalResolved,
    restorePending,
    clearForRun,
  }
}
