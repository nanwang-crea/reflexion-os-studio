import { CloseButton } from '../dialogs/CloseButton'
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
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <CloseButton
        ref={closeRef}
        className="image-preview-close"
        label="关闭图片预览"
        onClick={onClose}
      />
      <img src={src} alt={name} />
      <p>{name}</p>
    </dialog>
  )
}
