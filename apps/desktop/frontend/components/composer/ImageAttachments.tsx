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
  return (
    <div className="composer-images">
      {images.map((image) => (
        <div key={image.id} className="composer-image">
          <img src={image.url} alt={image.file.name} />
          <span title={image.file.name}>{image.file.name}</span>
          <button
            type="button"
            disabled={disabled}
            aria-label={`移除 ${image.file.name}`}
            onClick={() => onRemove(image.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
