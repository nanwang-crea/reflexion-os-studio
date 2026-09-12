import { useCallback, useRef, useState } from 'react'
import type { ConfirmDialogState } from '../components/ConfirmDialog'

/** 三键弹窗的结算结果：confirm=主确认，tertiary=第三键，cancel=取消/Esc。 */
export type ConfirmResult = 'confirm' | 'tertiary' | 'cancel'

export interface ConfirmDialogHandle {
  confirmState: ConfirmDialogState | null
  /** 应用内确认弹窗：promise 风格，供变更类操作等待用户决定。 */
  confirm: (state: ConfirmDialogState) => Promise<boolean>
  /** 三键版本：需要区分"主确认/第三键/取消"时使用。 */
  confirmAction: (state: ConfirmDialogState) => Promise<ConfirmResult>
  handleConfirm: () => void
  handleTertiary: () => void
  handleCancel: () => void
}

export function useConfirmDialog(): ConfirmDialogHandle {
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(
    null,
  )
  const resolverRef = useRef<((result: ConfirmResult) => void) | null>(null)

  const confirmAction = useCallback(
    (state: ConfirmDialogState): Promise<ConfirmResult> => {
      return new Promise((resolve) => {
        // 理论上不会连开两个弹窗；万一发生，先了结旧 promise 避免挂起。
        resolverRef.current?.('cancel')
        resolverRef.current = resolve
        setConfirmState(state)
      })
    },
    [],
  )

  const confirm = useCallback(
    async (state: ConfirmDialogState): Promise<boolean> =>
      (await confirmAction(state)) === 'confirm',
    [confirmAction],
  )

  const settle = useCallback((result: ConfirmResult): void => {
    setConfirmState(null)
    resolverRef.current?.(result)
    resolverRef.current = null
  }, [])

  const handleConfirm = useCallback(() => settle('confirm'), [settle])
  const handleTertiary = useCallback(() => settle('tertiary'), [settle])
  const handleCancel = useCallback(() => settle('cancel'), [settle])

  return {
    confirmState,
    confirm,
    confirmAction,
    handleConfirm,
    handleTertiary,
    handleCancel,
  }
}
