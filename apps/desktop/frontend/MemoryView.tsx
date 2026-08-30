import { useCallback, useEffect, useState } from 'react'
import type { Memory } from '@reflexion-os-studio/runtime-client'
import { PencilIcon, TrashIcon } from './ui/icons'
import { deleteMemory, listMemories, updateMemory } from './api/memory'
import { listProjects } from './api/projects'
import { listSessions } from './api/sessions'
import type { ConfirmDialogState } from './ConfirmDialog'

const SCOPE_LABELS: Record<string, string> = {
  session: '会话记忆',
  project: '项目记忆',
  user: '长期记忆',
}

const KIND_LABELS: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  procedure: '流程',
}

const SCOPE_ORDER = ['project', 'session', 'user'] as const

type Confirm = (state: ConfirmDialogState) => Promise<boolean>

interface MemoryViewProps {
  confirm: Confirm
}

/** scopeId → 可读名称（项目名/会话标题）；独立会话回退到“独立对话”。 */
function useScopeLabels(): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    let disposed = false
    void Promise.all([listSessions(), listProjects()])
      .then(([sessions, projects]) => {
        if (disposed) return
        const next: Record<string, string> = {}
        for (const project of projects.projects) {
          next[project.id] = `项目：${project.name}`
        }
        for (const session of sessions.sessions) {
          next[session.id] = `会话：${session.title}`
        }
        setLabels(next)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [])
  return labels
}

/**
 * 记忆管理页（A2）：按 scope 分组展示、编辑/固定/删除。
 * 自动写入的会话/项目记忆在此可撤销；user 级确认流程落地后此处承接确认入口。
 */
export function MemoryView(props: MemoryViewProps): React.JSX.Element {
  const [memories, setMemories] = useState<Memory[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const scopeLabels = useScopeLabels()

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await listMemories()
      setMemories(result.memories)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const fail = (error: unknown): void => {
    setNotice(error instanceof Error ? error.message : String(error))
  }

  const togglePin = async (memory: Memory): Promise<void> => {
    try {
      await updateMemory({
        id: memory.id,
        status: memory.status === 'pinned' ? 'active' : 'pinned',
      })
      await refresh()
    } catch (error) {
      fail(error)
    }
  }

  const saveEdit = async (id: string): Promise<void> => {
    const content = draft.trim()
    setEditingId(null)
    if (content === '') return
    try {
      await updateMemory({ id, content })
      await refresh()
    } catch (error) {
      fail(error)
    }
  }

  const remove = async (memory: Memory): Promise<void> => {
    const confirmed = await props.confirm({
      title: '删除记忆',
      message: `删除后 Agent 将不再召回这条记忆：“${memory.content.slice(0, 60)}”。确定删除？`,
      danger: true,
      confirmLabel: '删除',
    })
    if (!confirmed) return
    try {
      await deleteMemory(memory.id)
      await refresh()
    } catch (error) {
      fail(error)
    }
  }

  const grouped = SCOPE_ORDER.map((scope) => ({
    scope,
    items: memories.filter((memory) => memory.scope === scope),
  }))

  return (
    <div className="memory-view">
      <div className="memory-head">
        <p className="memory-hint">
          Agent 在对话结束时会自动提取有价值的信息存为记忆，并在后续对话中召回。
          会话/项目记忆为自动写入，可在此编辑或删除。
        </p>
        {notice && (
          <div className="memory-notice">
            <span>{notice}</span>
            <button className="ghost" onClick={() => setNotice(null)}>
              关闭
            </button>
          </div>
        )}
      </div>
      {memories.length === 0 ? (
        <div className="memory-empty">
          还没有记忆。与 Agent 对话后，有价值的信息会出现在这里。
        </div>
      ) : (
        grouped.map((group) => (
          <section key={group.scope} className="memory-group">
            <h2 className="memory-group-title">
              {SCOPE_LABELS[group.scope]}
              <span className="memory-group-count">{group.items.length}</span>
            </h2>
            {group.items.map((memory) => (
              <div
                key={memory.id}
                className={`memory-item ${memory.status === 'pinned' ? 'pinned' : ''}`}
              >
                {editingId === memory.id ? (
                  <div className="memory-edit">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      autoFocus
                    />
                    <div className="memory-edit-actions">
                      <button
                        className="ghost"
                        onClick={() => void saveEdit(memory.id)}
                      >
                        保存
                      </button>
                      <button
                        className="ghost"
                        onClick={() => setEditingId(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="memory-item-main">
                      <p className="memory-content">{memory.content}</p>
                      <div className="memory-meta">
                        <span className="memory-tag">
                          {KIND_LABELS[memory.kind] ?? memory.kind}
                        </span>
                        <span className="memory-tag">
                          {scopeLabels[memory.scopeId ?? ''] ??
                            (memory.scope === 'user' ? '全局' : memory.scopeId)}
                        </span>
                        <span className="memory-time">
                          {new Date(memory.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <div className="memory-actions">
                      <button
                        className={`msg-action ${memory.status === 'pinned' ? 'pin-active' : ''}`}
                        title={
                          memory.status === 'pinned'
                            ? '取消固定'
                            : '固定（始终召回）'
                        }
                        onClick={() => void togglePin(memory)}
                      >
                        <span className="memory-pin-glyph">📌</span>
                      </button>
                      <button
                        className="msg-action"
                        title="编辑"
                        onClick={() => {
                          setEditingId(memory.id)
                          setDraft(memory.content)
                        }}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        className="msg-action"
                        title="删除"
                        onClick={() => void remove(memory)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  )
}
