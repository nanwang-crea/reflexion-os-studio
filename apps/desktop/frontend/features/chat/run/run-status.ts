import type {
  Delegation,
  Run,
  ToolCall,
} from '@reflexion-os-studio/runtime-client'
import type { RunActivity } from '../../../hooks/session/useRunActivity'
import type { DelegationAttention } from './DelegationList'
import { toolLabel } from '../tools/labels'

export function runStatusLabel({
  active,
  status,
  activity,
  calls,
  delegations,
  attention,
  durationMs,
  retryLabel,
}: {
  active: boolean
  status?: Run['status']
  activity?: RunActivity
  calls: ToolCall[]
  delegations: Delegation[]
  attention?: ReadonlyMap<string, DelegationAttention>
  durationMs: number | null
  retryLabel?: string | null
}): string {
  if (!active) {
    if (status === 'failed') return '运行失败'
    if (status === 'cancelled') return '已取消'
    if (status === 'interrupted') return '已中断'
    return durationMs === null
      ? '处理完成'
      : `工作了 ${formatDuration(durationMs)}`
  }
  const children = delegations.filter(
    (item) => item.status === 'pending' || item.status === 'running',
  )
  const needsAttention = (kind: DelegationAttention): boolean =>
    children.some(
      (item) =>
        item.agentInstance && attention?.get(item.agentInstance.id) === kind,
    )
  if (
    status === 'awaiting_approval' ||
    calls.some((call) => call.status === 'awaiting_approval') ||
    needsAttention('approval')
  )
    return '等待审批'
  if (
    status === 'awaiting_user_input' ||
    calls.some((call) => call.status === 'awaiting_user_input') ||
    needsAttention('input')
  )
    return '等待回答'
  if (retryLabel) return retryLabel
  if (activity?.phase === 'preparing_tool')
    return activity.toolName === 'task'
      ? `正在准备子任务${activity.taskName ? `：${activity.taskName}` : ''}（参数接收中）`
      : '正在准备工具调用（参数接收中）'
  if (activity?.phase === 'thinking') return '思考中…'
  if (activity?.phase === 'answering') return '正在作答…'
  if (children.length > 0) return `等待 ${children.length} 个子 Agent 完成`
  const running = calls.find((call) => call.status === 'running')
  if (running) return `正在执行：${toolLabel(running)}`
  if (activity?.phase === 'waiting') return '等待模型响应'
  if (activity?.phase === 'tool') return '正在执行工具…'
  return '正在处理…'
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0)
    return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分`
  return `${secs} 秒`
}
