import { useRef } from 'react'
import { useModalDialog } from '../../hooks/ui/useModalDialog'
import { BrowserSettingsPanel } from '../../components/browser-settings/BrowserSettingsPanel'
export function BrowserSettingsDialog({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  const dialog = useModalDialog(true, close)
  return (
    <dialog
      ref={dialog}
      className="dialog-overlay confirm-dialog-modal"
      aria-label="浏览器设置"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="dialog browser-settings-dialog">
        <button type="button" ref={close} onClick={onClose}>
          关闭
        </button>
        <BrowserSettingsPanel />
      </div>
    </dialog>
  )
}
