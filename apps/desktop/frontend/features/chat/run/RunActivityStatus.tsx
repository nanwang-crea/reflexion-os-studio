import type {
  Delegation,
  Run,
  ToolCall,
} from '@reflexion-os-studio/runtime-client'
import type { RunActivity } from '../../../hooks/session/useRunActivity'
import type { DelegationAttention } from './DelegationList'
import { ChevronIcon } from '../../../ui/icons'
import type { RunDisplayMode } from '../../../hooks/ui/runDisplayMode'
import { runStatusLabel } from './run-status'
import { formatRetryLabel, useRetryCountdown } from './useRetryCountdown'

export function RunActivityStatus(props: {
  active: boolean
  status?: Run['status']
  activity?: RunActivity
  calls: ToolCall[]
  delegations: Delegation[]
  attention?: ReadonlyMap<string, DelegationAttention>
  durationMs: number | null
  hasProcess: boolean
  /** 是否允许展开过程正文（紧凑视图下只展示状态行）。 */
  collapsible?: boolean
  open: boolean
  onToggle: () => void
  /** 紧凑视图：追加当前活动详情（工具摘要/思考尾句）。 */
  detail?: string
  mode?: RunDisplayMode
  onToggleMode?: () => void
}): React.JSX.Element | null {
  const retry = props.active ? props.activity?.retry : undefined
  const countdown = useRetryCountdown(retry)
  const label = runStatusLabel({
    ...props,
    retryLabel: formatRetryLabel(retry, countdown),
  })
  const completed = props.calls.filter(
    (call) => call.status === 'completed' && call.errorCode === null,
  ).length
  if (!props.active && !props.hasProcess) return null
  const content = (
    <>
      <span className="run-process-label" role="status">
        <span
          className={
            props.activity?.phase === 'compacting'
              ? 'run-process-label shimmer'
              : undefined
          }
        >
          {label}
        </span>
        {props.detail ? (
          <span className="run-process-detail" title={props.detail}>
            {props.detail}
          </span>
        ) : null}
      </span>
      {completed > 0 && (
        <span className="run-process-count">已完成 {completed} 项工具调用</span>
      )}
      {props.collapsible && (
        <span className={`run-process-chevron${props.open ? ' open' : ''}`}>
          <ChevronIcon />
        </span>
      )}
    </>
  )
  return (
    <div className={`run-activity-status${props.active ? ' active' : ''}`}>
      <div className="run-status-row">
        {props.collapsible ? (
          <button
            type="button"
            className="run-process-toggle"
            aria-expanded={props.open}
            onClick={props.onToggle}
          >
            {content}
          </button>
        ) : (
          <div className="run-process-toggle">{content}</div>
        )}
        {props.onToggleMode !== undefined && (
          <button
            type="button"
            className="run-mode-toggle"
            title={`工作步骤：${
              props.mode === 'standard' ? '标准' : '详细'
            }视图（点击切换）`}
            aria-label={`切换工作步骤显示（当前${props.mode === 'standard' ? '标准' : '详细'}）`}
            onClick={props.onToggleMode}
          >
            {props.mode === 'standard' ? '标准' : '详细'}
          </button>
        )}
      </div>
    </div>
  )
}
