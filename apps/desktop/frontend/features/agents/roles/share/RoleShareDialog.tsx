import { useRef, useId, type ReactNode } from 'react'
import { useModalDialog } from '../../../../hooks/ui/useModalDialog'
import './role-share.css'

export function RoleShareDialog({
  title,
  busy,
  onClose,
  children,
}: {
  title: string
  busy: boolean
  onClose: () => void
  children: ReactNode
}) {
  const close = useRef<HTMLButtonElement>(null)
  const dialog = useModalDialog(true, close)
  const titleId = useId()
  return (
    <dialog
      ref={dialog}
      className="role-share-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button ref={close} type="button" disabled={busy} onClick={onClose}>
          关闭
        </button>
      </header>
      {children}
    </dialog>
  )
}
