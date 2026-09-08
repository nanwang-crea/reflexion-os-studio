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
        {/* 历史事件无时间锚点，不展示倒计时；活重试的倒计时在 RunBlock 标签上。 */}
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
