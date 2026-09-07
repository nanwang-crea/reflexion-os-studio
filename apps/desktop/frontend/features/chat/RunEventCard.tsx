import type { RunEvent } from '@reflexion-os-studio/runtime-client'
import { AlertIcon } from '../../ui/icons'

export function RunEventCard(props: { event: RunEvent }): React.JSX.Element {
  const { event } = props
  if (event.type === 'retrying') {
    return (
      <div className="run-event-card run-event-retry" role="status">
        <span>
          重试（第 {event.attempt}/{event.maxRetries} 次）
        </span>
        <span>{event.reason}</span>
      </div>
    )
  }
  return (
    <div className="run-event-card run-event-failure" role="alert">
      <AlertIcon size={15} />
      <span>
        运行失败（{event.errorCode}）：{event.errorMessage}
      </span>
    </div>
  )
}
