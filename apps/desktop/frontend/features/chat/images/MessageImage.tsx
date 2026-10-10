import { useModalDialog } from '../../../hooks/ui/useModalDialog'
import { useEffect, useRef, useState } from 'react'
import { readAsset } from '../../../api/assets'
import './message-images.css'

/** Load once per mounted attachment, including history after restart. */
export function MessageImage({
  assetId,
}: {
  assetId: string
}): React.JSX.Element {
  const [image, setImage] = useState<{
    src: string
    name: string
    size: number
  } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useModalDialog(expanded, closeRef)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setImage(null)
    setFailed(false)
    void readAsset(assetId)
      .then(({ asset, base64 }) => {
        if (!active) return
        if (
          !base64 ||
          !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
            asset.mimeType,
          )
        ) {
          setFailed(true)
          return
        }
        setImage({
          src: `data:${asset.mimeType};base64,${base64}`,
          name: asset.fileName,
          size: asset.size,
        })
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [assetId])
  if (!image)
    return (
      <span className="message-image-state" role="status">
        {failed ? '图片不可用' : '加载图片…'}
      </span>
    )
  return (
    <figure className="message-image">
      <button
        type="button"
        className="message-image-open"
        onClick={() => setExpanded(true)}
        aria-label={`放大 ${image.name}`}
      >
        <img
          src={image.src}
          alt={image.name}
          loading="lazy"
          onError={() => {
            setImage(null)
            setFailed(true)
          }}
        />
      </button>
      <figcaption title={image.name}>
        {image.name} · {Math.ceil(image.size / 1024)} KB
      </figcaption>
      {expanded && (
        <dialog
          ref={dialogRef}
          className="message-image-dialog"
          onCancel={(event) => {
            event.preventDefault()
            setExpanded(false)
          }}
        >
          <button
            type="button"
            ref={closeRef}
            onClick={() => setExpanded(false)}
          >
            关闭
          </button>
          <img src={image.src} alt={image.name} />
          <p>{image.name}</p>
        </dialog>
      )}
    </figure>
  )
}
