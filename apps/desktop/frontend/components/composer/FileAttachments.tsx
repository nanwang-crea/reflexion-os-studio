import { useState } from 'react'
import { ImagePreview } from '../images/ImagePreview'
import type { DraftAttachment } from './useComposerAttachments'
import './images.css'

export function FileAttachments({
  images,
  disabled,
  onRemove,
}: {
  images: DraftAttachment[]
  disabled: boolean
  onRemove: (id: string) => void
}): React.JSX.Element {
  const [previewId, setPreviewId] = useState<string | null>(null)
  const preview = images.find((image) => image.id === previewId)
  return (
    <div className="composer-images">
      {images.map((image) => (
        <div key={image.id} className="composer-image">
          {image.file.type.startsWith('image/') ? (
            <button
              type="button"
              className="composer-image-open"
              aria-label={`预览 ${image.file.name}`}
              onClick={() => setPreviewId(image.id)}
            >
              <img src={image.url} alt={image.file.name} />
            </button>
          ) : (
            <span className="composer-file-label">文件 · 待发送</span>
          )}
          <span title={image.file.name}>
            {image.file.name} · {Math.ceil(image.file.size / 1024)} KB
          </span>
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
