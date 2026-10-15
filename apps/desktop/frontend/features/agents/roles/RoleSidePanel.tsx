import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

export function RoleSidePanel({
  title,
  label,
  busy,
  onClose,
  children,
  bodyRef,
}: {
  title: string
  label?: string
  busy: boolean
  onClose: () => void
  children: ReactNode
  bodyRef?: RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus()
    }
  }, [])
  return (
    <aside
      className="agent-role-side-panel"
      role="dialog"
      aria-modal="false"
      aria-label={label ?? title}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          if (!busy) onClose()
        }
      }}
    >
      <header className="agent-role-panel-heading">
        <h2>{title}</h2>
        <button ref={close} type="button" disabled={busy} onClick={onClose}>
          关闭
        </button>
      </header>
      <div className="agent-role-panel-body" ref={bodyRef}>
        {children}
      </div>
    </aside>
  )
}
