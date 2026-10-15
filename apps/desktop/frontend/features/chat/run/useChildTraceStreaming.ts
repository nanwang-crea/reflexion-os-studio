import { useEffect, useRef } from 'react'
import { transport } from '../../../lib/transport'
import { useStreamingCache } from '../../../hooks/session/useStreamingCache'

/** Child drafts are only persisted at turn completion; consume live deltas. */
export function useChildTraceStreaming(
  sessionId: string | null,
  runIds: string[],
) {
  const cache = useStreamingCache()
  const latest = useRef({ sessionId, cache, runIds })
  latest.current = { sessionId, cache, runIds }
  const { reset } = cache
  useEffect(() => {
    reset()
  }, [sessionId, reset])
  useEffect(
    () =>
      transport.onEvent((event) => {
        const { cache, runIds } = latest.current
        if (!('runId' in event) || !runIds.includes(event.runId)) return
        if (event.type === 'message.delta')
          cache.applyDelta(event.messageId, event.runId, event.delta)
        else if (event.type === 'message.reasoning_delta')
          cache.applyReasoningDelta(event.messageId, event.runId, event.delta)
        else if (event.type === 'message.reset')
          cache.applyReset(event.messageId)
        else if (event.type === 'message.completed')
          cache.applyCompleted(event.messageId, event.runId, event.content)
      }),
    [],
  )
  return cache
}
