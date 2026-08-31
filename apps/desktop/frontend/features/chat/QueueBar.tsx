import { useCallback, useEffect, useState } from 'react'
import type { QueueEntry } from '@reflexion-os-studio/runtime-client'
import {
  listQueue,
  onQueueChanged,
  removeQueue,
  sendNow,
  updateQueue,
} from '../../api/queue'
import { SendIcon, TrashIcon } from '../../ui/icons'

const PREVIEW_MAX = 80

interface QueueBarProps {
  sessionId: string
}

/**
 * 会话发送队列：上一条回复进行中继续输入的消息在此排队(FIFO)，
 * 等待发送时支持修改内容、删除、立即发送(移到队首)。
 */
export function QueueBar(props: QueueBarProps): React.JSX.Element {
  const [items, setItems] = useState<QueueEntry[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await listQueue(props.sessionId)
      setItems(result.items)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [props.sessionId])

  useEffect(() => {
    setItems([])
    setEditingId(null)
    void refresh()
  }, [props.sessionId, refresh])

  useEffect(() => {
    return onQueueChanged((sessionId, next) => {
      if (sessionId !== props.sessionId) return
      setItems(next)
      // 编辑中的项不在队列里(被发送走了)时退出编辑态。
      setEditingId((current) =>
        current !== null && !next.some((entry) => entry.id === current)
          ? null
          : current,
      )
    })
  }, [props.sessionId])

  const startEdit = (entry: QueueEntry): void => {
    setEditingId(entry.id)
    setDraft(entry.content)
    setError(null)
  }

  const saveEdit = async (): Promise<void> => {
    if (editingId === null || draft.trim() === '') return
    try {
      const result = await updateQueue(props.sessionId, editingId, draft.trim())
      if (result.item === null) setEditingId(null)
      else setEditingId(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const remove = async (queueId: string): Promise<void> => {
    try {
      await removeQueue(props.sessionId, queueId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const sendNowClick = async (queueId: string): Promise<void> => {
    try {
      await sendNow(props.sessionId, queueId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  if (items.length === 0) return <></>

  return (
    <div className="queue-bar">
      <div className="queue-head">
        <span>发送队列（等待上一条回复结束）</span>
        <span className="queue-count">{items.length} 条</span>
      </div>
      <ul className="queue-list">
        {items.map((entry) => (
          <li className="queue-item" key={entry.id}>
            {editingId === entry.id ? (
              <textarea
                className="queue-edit"
                value={draft}
                rows={2}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void saveEdit()
                  }
                  if (event.key === 'Escape') setEditingId(null)
                }}
              />
            ) : (
              <span className="queue-content" title={entry.content}>
                {entry.content.length > PREVIEW_MAX
                  ? `${entry.content.slice(0, PREVIEW_MAX)}…`
                  : entry.content}
              </span>
            )}
            <span className="queue-actions">
              {editingId === entry.id ? (
                <>
                  <button
                    className="ghost"
                    onClick={() => void saveEdit()}
                    disabled={draft.trim() === ''}
                  >
                    保存
                  </button>
                  <button className="ghost" onClick={() => setEditingId(null)}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button className="ghost" onClick={() => startEdit(entry)}>
                    修改
                  </button>
                  <button
                    className="ghost"
                    onClick={() => void sendNowClick(entry.id)}
                  >
                    <SendIcon />
                    立即发送
                  </button>
                </>
              )}
              <button
                className="icon-btn danger"
                title="删除"
                onClick={() => void remove(entry.id)}
              >
                <TrashIcon />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && <div className="queue-error">{error}</div>}
    </div>
  )
}
