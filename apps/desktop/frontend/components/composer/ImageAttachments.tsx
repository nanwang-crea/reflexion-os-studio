import { useState } from 'react'
import { ImagePreview } from '../images/ImagePreview'
import type { DraftImage } from './useComposerImages'
import './images.css'

export function ImageAttachments({
  images,
  disabled,
  onRemove,
}: {
  images: DraftImage[]
  disabled: boolean
  onRemove: (id: string) => void
}): React.JSX.Element {
  const [previewId, setPreviewId] = useState<string | null>(null)
  const preview = images.find((image) => image.id === previewId)
  return (
    <div className="composer-images">
      {images.map((image) => (
        <div key={image.id} className="composer-image">
          <button
            type="button"
            className="composer-image-open"
            aria-label={`预览 ${image.file.name}`}
            onClick={() => setPreviewId(image.id)}
          >
            <img src={image.url} alt={image.file.name} />
          </button>
          <span title={image.file.name}>{image.file.name}</span>
          <button
            type="button"
            className="composer-image-remove"
            disabled={disabled}
            aria-label={`移除 ${image.file.name}`}
            onClick={() => onRemove(image.id)}
          >
            ×
          </button>
        </div>
      ))}
      {preview && (
        <ImagePreview
          src={preview.url}
          name={preview.file.name}
          onClose={() => setPreviewId(null)}
        />
      )}
    </div>
  )
}
