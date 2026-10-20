import type {
  Delegation,
  Run,
  ToolCall,
} from '@reflexion-os-studio/runtime-client'
import type { RunActivity } from '../../../hooks/session/useRunActivity'
import type { DelegationAttention } from './DelegationList'
import { ChevronIcon } from '../../../ui/icons'
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
  open: boolean
  onToggle: () => void
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
        {label}
      </span>
      {completed > 0 && (
        <span className="run-process-count">已完成 {completed} 项工具调用</span>
      )}
      {props.hasProcess && (
        <span className={`run-process-chevron${props.open ? ' open' : ''}`}>
          <ChevronIcon />
        </span>
      )}
    </>
  )
  return (
    <div className={`run-activity-status${props.active ? ' active' : ''}`}>
      {props.hasProcess ? (
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
    </div>
  )
}
