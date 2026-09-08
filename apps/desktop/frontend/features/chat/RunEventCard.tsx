import type { RunEvent } from '@reflexion-os-studio/runtime-client'
import { AlertIcon } from '../../ui/icons'

export function RunEventCard(props: { event: RunEvent }): React.JSX.Element {
  const { event } = props
  return (
    <div className="run-event-card run-event-failure" role="alert">
      <AlertIcon size={15} />
      <span>
        运行失败（{event.errorCode}）：{event.errorMessage}
      </span>
    </div>
  )
}
