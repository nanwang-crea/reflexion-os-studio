import { MessageImage } from '../images/MessageImage'
import { isComposing } from '../../../lib/keyboard'
import type { Message } from '@reflexion-os-studio/runtime-client'
import { CopyButton } from '../../../components/CopyButton'
import { PencilIcon } from '../../../ui/icons'

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
}): React.JSX.Element {
  return (
    <div className="msg-user">
      <div className={`user-bubble${editing ? ' user-bubble-editing' : ''}`}>
        <div className="message-images">
          {message.parts
            .filter((part) => part.type === 'image')
            .map((part) => (
              <MessageImage key={part.assetId} assetId={part.assetId} />
            ))}
        </div>
        {editing ? (
          <div className="edit-resend-inline">
            <textarea
              className="edit-resend-textarea"
              rows={4}
              value={editDraft}
              onChange={(event) => onDraftChange(event.target.value)}
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
                disabled={editSaving || editDraft.trim() === ''}
              >
                {editSaving ? '发送中…' : '发送'}
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
