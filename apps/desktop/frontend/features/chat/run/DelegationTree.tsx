import type { Delegation } from '@reflexion-os-studio/runtime-client'

interface DelegationTreeProps {
  items: Delegation[]
  rootRunId: string
  selectedId: string
  onSelect: (delegation: Delegation) => void
}

const STATUS_LABELS: Record<Delegation['status'], string> = {
  pending: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function Branch({
  parentRunId,
  items,
  selectedId,
  onSelect,
}: Omit<DelegationTreeProps, 'rootRunId'> & {
  parentRunId: string
}): React.JSX.Element {
  const children = items.filter((item) => item.parentRunId === parentRunId)
  return (
    <ul className="delegation-tree-branch">
      {children.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={item.id === selectedId ? 'selected' : ''}
            onClick={() => onSelect(item)}
          >
            <span>{item.agentInstance?.name ?? item.agentId}</span>
            <span className={`delegation-tree-status ${item.status}`}>
              {STATUS_LABELS[item.status]}
            </span>
            <small>{item.task}</small>
          </button>
          {item.childRunId && (
            <Branch
              parentRunId={item.childRunId}
              items={items}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          )}
        </li>
      ))}
    </ul>
  )
}

/** Flat persisted records are projected into a navigable run/delegation tree. */
export function DelegationTree({
  items,
  rootRunId,
  selectedId,
  onSelect,
}: DelegationTreeProps): React.JSX.Element {
  return (
    <nav aria-label="子 Agent 委派树" className="delegation-tree">
      <strong>任务委派</strong>
      <Branch
        parentRunId={rootRunId}
        items={items}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </nav>
  )
}
