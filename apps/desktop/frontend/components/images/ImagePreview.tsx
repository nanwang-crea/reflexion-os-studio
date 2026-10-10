import { useRef } from 'react'
import { useModalDialog } from '../../hooks/ui/useModalDialog'
import './image-preview.css'

/** Mounted only while open; closing restores focus to the thumbnail. */
export function ImagePreview({
  src,
  name,
  onClose,
}: {
  src: string
  name: string
  onClose: () => void
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useModalDialog(true, closeRef)
  return (
    <dialog
      ref={dialogRef}
      className="image-preview-dialog"
      aria-label={`预览 ${name}`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <button type="button" ref={closeRef} onClick={onClose}>
        关闭
      </button>
      <img src={src} alt={name} />
      <p>{name}</p>
    </dialog>
  )
}
