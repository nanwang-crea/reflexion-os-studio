import { useEffect, useRef, useState } from 'react'
import type { Session } from '@reflexion-os-studio/runtime-client'
import { PencilIcon, TrashIcon } from '../ui/icons'

/** 会话行：悬停浮现重命名/删除；重命名走行内输入（Enter 提交、Esc 取消）。 */
export function SessionRow(props: {
  session: Session
  active: boolean
  running?: boolean
  completed?: boolean
  failed?: boolean
  /** 有等待审批的工具调用：优先级最高（待审批 > 失败 > 成功）。 */
  pendingApproval?: boolean
  onSelect: () => void
  onRename: (title: string) => Promise<void>
  onDelete: () => Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(props.session.title)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const startRename = (): void => {
    setEditTitle(props.session.title)
    setEditing(true)
  }

  // 侧栏标记优先级：待审批 > 失败 > 成功；正在查看的会话不显示完成标
  //（避免阅读回复时的侧栏噪音，切走后若仍未确认则恢复显示）。
  const showCompleted =
    (props.completed ?? false) && !props.active && !props.pendingApproval
  const showFailed = (props.failed ?? false) && !props.pendingApproval
  const statusKind = props.pendingApproval
    ? 'approval'
    : props.running
      ? 'running'
      : showFailed
        ? 'failed'
        : showCompleted
          ? 'completed'
          : null

  const submitRename = async (): Promise<void> => {
    // Enter 提交后输入框尚在挂载，紧接的 blur 会再次触发；防重入。
    if (pending) return
    const title = editTitle.trim()
    if (!title || title === props.session.title) {
      setEditing(false)
      return
    }
    setPending(true)
    try {
      await props.onRename(title)
      setEditing(false)
    } catch {
      setEditTitle(props.session.title)
      setEditing(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={`session-row${props.active ? ' active' : ''}`}>
      {editing ? (
        <input
          ref={inputRef}
          className="rename-input"
          value={editTitle}
          disabled={pending}
          onChange={(event) => setEditTitle(event.target.value)}
          onBlur={() => void submitRename()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submitRename()
            } else if (event.key === 'Escape') {
              setEditing(false)
              setEditTitle(props.session.title)
            }
          }}
        />
      ) : (
        <button
          className="row session-main"
          title={props.session.title}
          onClick={props.onSelect}
        >
          <span
            className={`session-status${statusKind === null ? '' : ` ${statusKind}`}`}
            aria-label={
              statusKind === 'approval'
                ? '有工具调用等待审批'
                : statusKind === 'running'
                  ? '正在回复'
                  : statusKind === 'failed'
                    ? '回复失败'
                    : statusKind === 'completed'
                      ? '回复完成'
                      : undefined
            }
          >
            {statusKind === 'approval' ? (
              '✋'
            ) : statusKind === 'running' ? (
              <span className="session-spinner" />
            ) : statusKind === 'failed' ? (
              '!'
            ) : statusKind === 'completed' ? (
              '✓'
            ) : null}
          </span>
          <span className="row-label">{props.session.title}</span>
        </button>
      )}
      {editing ? (
        <span className="row-hint">{pending ? '保存中…' : 'Enter 确认'}</span>
      ) : (
        <span className="session-actions">
          <button
            className="row-action"
            title="重命名"
            aria-label="重命名会话"
            onClick={startRename}
          >
            <PencilIcon />
          </button>
          <button
            className="row-action danger"
            title="删除会话"
            aria-label="删除会话"
            onClick={() => void props.onDelete()}
          >
            <TrashIcon />
          </button>
        </span>
      )}
    </div>
  )
}
