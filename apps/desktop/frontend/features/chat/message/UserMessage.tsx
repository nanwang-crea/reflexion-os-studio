import { ATTACHMENT_ACCEPT } from '@reflexion-os-studio/runtime-client'
import { MessageFile } from './MessageFile'
import { MessageImage } from '../images/MessageImage'
import { isComposing } from '../../../lib/keyboard'
import type { Message } from '@reflexion-os-studio/runtime-client'
import { CopyButton } from '../../../components/CopyButton'
import { PencilIcon } from '../../../ui/icons'
import type { DraftAttachment } from '../../../components/composer/useComposerAttachments'
import { useRef } from 'react'

export function UserMessage({
  message,
  editing,
  editable,
  editDraft,
  editSaving,
  onDraftChange,
  onCancel,
  onSave,
  onEdit,
  editImageAssetIds,
  editImages,
  editImageError,
  onAddImages,
  onRemoveImage,
  onRemoveAsset,
}: {
  message: Message
  editing: boolean
  editable: boolean
  editDraft: string
  editSaving: boolean
  onDraftChange: (value: string) => void
  onCancel: () => void
  onSave: () => Promise<void>
  onEdit: () => void
  editImageAssetIds: string[]
  editImages: DraftAttachment[]
  editImageError: string | null
  onAddImages: (files: File[]) => void
  onRemoveImage: (id: string) => void
  onRemoveAsset: (assetId: string) => void
}): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const handleFiles = (files: FileList | null): void => {
    if (!files) return
    onAddImages(Array.from(files))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }
  const hasEditContent =
    editDraft.trim() !== '' ||
    editImageAssetIds.length > 0 ||
    editImages.length > 0

  return (
    <div className="msg-user">
      <div className={`user-bubble${editing ? ' user-bubble-editing' : ''}`}>
        {!editing && (
          <div className="message-images">
            {message.parts
              .filter((part) => part.type === 'image')
              .map((part) => (
                <MessageImage key={part.assetId} assetId={part.assetId} />
              ))}
          </div>
        )}
        {!editing &&
          message.parts
            .filter((part) => part.type === 'file')
            .map((part) => <MessageFile key={part.assetId} part={part} />)}
        {editing ? (
          <div className="edit-resend-inline">
            <div className="edit-image-attachments">
              {editImageAssetIds.map((assetId) => (
                <div key={assetId} className="edit-image-item">
                  {message.parts
                    .filter((part) => part.type === 'file')
                    .filter((part) => part.assetId === assetId)
                    .map((part) => (
                      <MessageFile key={part.assetId} part={part} />
                    ))}
                  {message.parts.some(
                    (part) => part.type === 'image' && part.assetId === assetId,
                  ) && <MessageImage assetId={assetId} />}
                  <button
                    type="button"
                    className="edit-image-remove"
                    onClick={() => onRemoveAsset(assetId)}
                    disabled={editSaving}
                    aria-label="移除原附件"
                  >
                    ×
                  </button>
                </div>
              ))}
              {editImages.map((image) => (
                <div key={image.id} className="edit-image-item">
                  {image.file.type.startsWith('image/') ? (
                    <img src={image.url} alt={image.file.name} />
                  ) : (
                    <span>{image.file.name}</span>
                  )}
                  <button
                    type="button"
                    className="edit-image-remove"
                    onClick={() => onRemoveImage(image.id)}
                    disabled={editSaving}
                    aria-label={`移除 ${image.file.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {editImageError && (
              <div className="edit-image-error" role="alert">
                {editImageError}
              </div>
            )}
            <textarea
              className="edit-resend-textarea"
              rows={4}
              value={editDraft}
              onChange={(event) => onDraftChange(event.target.value)}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files)
                if (files.length > 0) {
                  event.preventDefault()
                  onAddImages(files)
                }
              }}
              onKeyDown={(event) => {
                if (isComposing(event.nativeEvent)) return
                if (event.key === 'Escape') onCancel()
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void onSave()
                }
              }}
              disabled={editSaving}
              autoFocus
            />
            <div className="edit-resend-actions">
              <input
                ref={fileInputRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                multiple
                hidden
                onChange={(event) => handleFiles(event.target.files)}
              />
              <button
                type="button"
                className="ghost edit-image-add"
                onClick={() => fileInputRef.current?.click()}
                disabled={editSaving}
              >
                添加文件
              </button>
              <button
                type="button"
                className="ghost"
                onClick={onCancel}
                disabled={editSaving}
              >
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void onSave()}
                disabled={editSaving || !hasEditContent}
              >
                {editSaving ? '上传并发送中…' : '发送'}
              </button>
            </div>
          </div>
        ) : (
          <div className="user-content">{message.content}</div>
        )}
      </div>
      {!editing && (
        <div className="user-actions">
          <CopyButton text={message.content} />
          {editable && (
            <button
              type="button"
              className="msg-action"
              title="编辑并重发"
              aria-label="编辑并重发"
              onClick={() => onEdit()}
            >
              <PencilIcon />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
