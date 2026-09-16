import { useCallback } from 'react'
import { resolveApproval } from '../api/chat'
import type { PendingApproval } from './useAppBootstrap'

/**
 * 审批决策派发：approval.resolve 命令 + 乐观摘卡，命令发出即移除等待卡，
 * 不等 approval.resolved 事件走完 runtime→宿主→webview 往返（同一事件管道
 * 积压时卡片会滞留）。命令失败则按原队列位置恢复整条 PendingApproval 重试；
 * 事件回执到达时按 toolCallId 幂等，摘除已不存在的卡无副作用。
 */
export function useApprovalResolution(deps: {
  pendingApprovals: PendingApproval[]
  clearPendingApproval: (toolCallId: string) => void
  restorePendingApproval: (entry: PendingApproval) => void
  setNotice: (notice: string | null) => void
}): (toolCallId: string, choiceId: string) => Promise<void> {
  const {
    pendingApprovals,
    clearPendingApproval,
    restorePendingApproval,
    setNotice,
  } = deps
  return useCallback(
    async (toolCallId: string, choiceId: string): Promise<void> => {
      const entry = pendingApprovals.find(
        (item) => item.toolCallId === toolCallId,
      )
      if (entry !== undefined) clearPendingApproval(toolCallId)
      try {
        await resolveApproval({ toolCallId, choiceId })
      } catch (error) {
        if (entry !== undefined) restorePendingApproval(entry)
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [pendingApprovals, clearPendingApproval, restorePendingApproval, setNotice],
  )
}
