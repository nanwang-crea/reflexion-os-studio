import { useRef, type ReactNode } from 'react'
import { useModalDialog } from '../../hooks/ui/useModalDialog'
import { CloseButton } from './CloseButton'
import './read-only-dialog.css'

/** Read-only views can dismiss on the backdrop; confirmations keep their own flow. */
export function ReadOnlyDialog({
  label,
  title,
  children,
  onClose,
  drawer = false,
}: {
  label: string
  title: ReactNode
  children: ReactNode
  onClose: () => void
  drawer?: boolean
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useModalDialog(true, closeRef)
  return (
    <dialog
      ref={dialogRef}
      className={`read-only-dialog${drawer ? ' read-only-drawer' : ''}`}
      aria-label={label}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <section className="read-only-dialog-panel">
        <header className="read-only-dialog-head">
          <div className="read-only-dialog-title">{title}</div>
          <CloseButton
            ref={closeRef}
            label={`关闭${label}`}
            onClick={onClose}
          />
        </header>
        <div className="read-only-dialog-content">{children}</div>
      </section>
    </dialog>
  )
}
