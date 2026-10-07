import { useEffect, useRef, type RefObject } from 'react'

/** 顶层模态隔离背景；初始聚焦安全按钮，关闭后恢复原触发控件。 */
export function useModalDialog(
  open: boolean,
  initialFocus: RefObject<HTMLButtonElement | null>,
): RefObject<HTMLDialogElement | null> {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    const dialog = dialogRef.current
    dialog?.showModal()
    initialFocus.current?.focus()
    return () => {
      dialog?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus()
    }
  }, [open, initialFocus])
  return dialogRef
}
