import { useState } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { ChevronIcon } from '../../ui/icons'

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

  if (items.length === 0) return <></>
  const running = items.some(
    (entry) => entry.status === 'pending' || entry.status === 'running',
  )

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
          子 Agent（{items.length}）
        </span>
        <span className={`run-process-chevron${open ? ' open' : ''}`}>
          <ChevronIcon />
        </span>
      </button>
      {open && (
        <div className="delegation-body">
          {items.map((delegation) => (
            <div key={delegation.id} className="delegation-row">
              <span
                className={`delegation-status ${delegation.status}`}
                aria-label={`状态：${STATUS_LABELS[delegation.status]}`}
              >
                {STATUS_LABELS[delegation.status]}
              </span>
              <div className="delegation-content">
                <div className="delegation-head">
                  <span className="delegation-agent">{delegation.agentId}</span>
                </div>
                <div className="delegation-task">{delegation.task}</div>
                {delegation.result && (
                  <div className="delegation-result">{delegation.result}</div>
                )}
                {delegation.error && (
                  <div className="delegation-error">{delegation.error}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
