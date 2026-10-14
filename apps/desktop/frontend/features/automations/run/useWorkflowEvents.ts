import { useEffect, useRef } from 'react'
import type { RuntimeEvent } from '@reflexion-os-studio/contracts'
import { transport } from '../../../lib/transport'

/** One subscription per mount; coalesce invalidations, no idle polling. */
export function useWorkflowEvents(
  onEvent: (event: RuntimeEvent) => void,
): void {
  const latest = useRef(onEvent)
  latest.current = onEvent
  useEffect(() => {
    const events = new Map<string, RuntimeEvent>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = transport.onEvent((event) => {
      if (
        event.type !== 'workflow.run.updated' &&
        event.type !== 'workflow.generation.updated'
      )
        return
      const key =
        event.type === 'workflow.run.updated'
          ? event.workflowRunId
          : event.generationId
      const previous = events.get(key)
      if (
        event.type === 'workflow.run.updated' &&
        previous?.type === event.type &&
        previous.stateVersion > event.stateVersion
      )
        return
      events.set(key, event)
      timer ??= setTimeout(() => {
        timer = undefined
        const pending = [...events.values()]
        events.clear()
        for (const event of pending) latest.current(event)
      }, 32)
    })
    return () => {
      dispose()
      clearTimeout(timer)
    }
  }, [])
}
