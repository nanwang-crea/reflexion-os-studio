import { useState } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { cancelDelegation } from '../../../api/agents'
import { ChevronIcon } from '../../../ui/icons'
import { ChildAgentTrace } from './ChildAgentTrace'

interface DelegationListProps {
  items: Delegation[]
  runActive: boolean
}

const STATUS_LABELS: Record<Delegation['status'], string> = {
  pending: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 父 Run 发起的子 Agent 委派列表：状态徽标 + 任务摘要 + 结果/错误。 */
export function DelegationList({
  items,
  runActive,
}: DelegationListProps): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [traceId, setTraceId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (items.length === 0) return <></>
  const running = items.some(
    (entry) => entry.status === 'pending' || entry.status === 'running',
  )
  const trace = items.find((item) => item.id === traceId) ?? null

  return (
    <div className="delegation-list">
      <button
        type="button"
        className="delegation-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className={`delegation-label${running || runActive ? ' shimmer' : ''}`}
        >
          子任务（{items.length}）
        </span>
        <span className={`run-process-chevron${open ? ' open' : ''}`}>
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div className="delegation-body">
          {items.map((delegation) => (
            <div
              key={delegation.id}
              className={`delegation-row status-${delegation.status}`}
            >
              <button
                type="button"
                className="delegation-open"
                disabled={delegation.childSessionId === null}
                onClick={() => setTraceId(delegation.id)}
              >
                <span
                  className={`trace-dot${
                    delegation.status === 'pending' ||
                    delegation.status === 'running'
                      ? ' pulse'
                      : ''
                  }`}
                  aria-hidden
                />
                <span className="trace-name">
                  {delegation.agentInstance?.name ?? delegation.agentId}
                </span>
                <span className="trace-summary">
                  {delegation.task.replace(/\s+/g, ' ').trim()}
                </span>
                <span className="trace-status">
                  {STATUS_LABELS[delegation.status]}
                </span>
              </button>
              {['pending', 'running'].includes(delegation.status) && (
                <button
                  type="button"
                  className="ghost danger delegation-cancel"
                  disabled={cancellingId === delegation.id}
                  onClick={() => {
                    setCancellingId(delegation.id)
                    setActionError(null)
                    void cancelDelegation(delegation.id)
                      .then(({ accepted }) => {
                        if (!accepted)
                          setActionError('子 Agent 已结束或无法取消')
                      })
                      .catch((caught) =>
                        setActionError(
                          caught instanceof Error
                            ? caught.message
                            : String(caught),
                        ),
                      )
                      .finally(() => setCancellingId(null))
                  }}
                >
                  {cancellingId === delegation.id ? '取消中…' : '取消'}
                </button>
              )}
              {delegation.error && (
                <div className="delegation-error">{delegation.error}</div>
              )}
            </div>
          ))}
          {actionError && (
            <div className="delegation-error" role="alert">
              {actionError}
            </div>
          )}
        </div>
      )}
      {trace && (
        <ChildAgentTrace delegation={trace} onClose={() => setTraceId(null)} />
      )}
    </div>
  )
}
