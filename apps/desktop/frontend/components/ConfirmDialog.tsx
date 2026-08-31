import { useEffect, useRef } from 'react'

export interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作（如删除）时确认按钮显示为红色。 */
  danger?: boolean
}

interface ConfirmDialogProps {
  state: ConfirmDialogState | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 应用内确认弹窗：居中悬浮、跟随深色主题、宽度自适应视口
 * （替代比例与主题不搭的系统原生对话框）。
 */
export function ConfirmDialog(
  props: ConfirmDialogProps,
): React.JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const { onCancel } = props
  const open = props.state !== null

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onCancel])

  if (!props.state) return null
  const state = props.state

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={props.onCancel}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={state.title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="dialog-title">{state.title}</h3>
        <p className="dialog-message">{state.message}</p>
        <div className="dialog-actions">
          <button ref={cancelRef} className="ghost" onClick={props.onCancel}>
            {state.cancelLabel ?? '取消'}
          </button>
          <button
            className={state.danger ? 'dialog-danger' : ''}
            onClick={props.onConfirm}
          >
            {state.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
