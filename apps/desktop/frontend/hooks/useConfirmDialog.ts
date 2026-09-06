import { useCallback, useRef, useState } from 'react'
import type { ConfirmDialogState } from '../components/ConfirmDialog'

export interface ConfirmDialogHandle {
  confirmState: ConfirmDialogState | null
  /** 应用内确认弹窗：promise 风格，供变更类操作等待用户决定。 */
  confirm: (state: ConfirmDialogState) => Promise<boolean>
  handleConfirm: () => void
  handleCancel: () => void
}

export function useConfirmDialog(): ConfirmDialogHandle {
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(
    null,
  )
  const resolverRef = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((state: ConfirmDialogState): Promise<boolean> => {
    return new Promise((resolve) => {
      // 理论上不会连开两个弹窗；万一发生，先了结旧 promise 避免挂起。
      resolverRef.current?.(false)
      resolverRef.current = resolve
      setConfirmState(state)
    })
  }, [])

  const settleConfirm = useCallback((ok: boolean): void => {
    setConfirmState(null)
    resolverRef.current?.(ok)
    resolverRef.current = null
  }, [])

  const handleConfirm = useCallback(() => settleConfirm(true), [settleConfirm])
  const handleCancel = useCallback(() => settleConfirm(false), [settleConfirm])

  return { confirmState, confirm, handleConfirm, handleCancel }
}
