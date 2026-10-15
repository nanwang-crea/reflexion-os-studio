import { useState } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import type { RunActivity } from '../../../hooks/session/useRunActivity'
import { ChildAgentTrace } from './ChildAgentTrace'

export function RunActivityStatus({
  active,
  activity,
  delegations,
}: {
  active: boolean
  activity?: RunActivity
  delegations: Delegation[]
}): React.JSX.Element | null {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const children = delegations.filter(
    (item) =>
      active && (item.status === 'pending' || item.status === 'running'),
  )
  const selected = delegations.find((item) => item.id === selectedId)
  const label =
    !active || activity?.retry
      ? null
      : activity?.phase === 'preparing_tool'
        ? activity.toolName === 'task'
          ? `正在准备子任务${activity.taskName ? `：${activity.taskName}` : ''}（参数接收中）`
          : '正在准备工具调用（参数接收中）'
        : activity?.phase === 'waiting' && children.length === 0
          ? '等待模型响应'
          : null
  if (!label && children.length === 0 && !selected) return null
  return (
    <div className="run-activity-status">
      {label && <div role="status">{label}</div>}
      {children.length > 0 && (
        <button
          type="button"
          className="run-child-wait"
          onClick={() => setSelectedId(children[0].id)}
        >
          等待 {children.length} 个子 Agent 完成 · 查看执行过程
        </button>
      )}
      {selected && (
        <ChildAgentTrace
          key={selected.id}
          delegation={selected}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}
