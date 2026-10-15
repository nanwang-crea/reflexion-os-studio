import { useEffect, useRef } from 'react'
import { transport } from '../../../lib/transport'
import { useRunActivity } from '../../../hooks/session/useRunActivity'
import { useStreamingCache } from '../../../hooks/session/useStreamingCache'

/** Child drafts are only persisted at turn completion; consume live deltas. */
export function useChildTraceStreaming(
  sessionId: string | null,
  runIds: string[],
) {
  const cache = useStreamingCache()
  const activity = useRunActivity()
  const latest = useRef({ sessionId, cache, runIds, activity })
  latest.current = { sessionId, cache, runIds, activity }
  const { reset } = cache
  const { clearAllRunActivities } = activity
  useEffect(() => {
    reset()
    clearAllRunActivities()
  }, [sessionId, reset, clearAllRunActivities])
  useEffect(
    () =>
      transport.onEvent((event) => {
        const { cache, runIds, activity } = latest.current
        if (!('runId' in event) || !runIds.includes(event.runId)) return
        if (event.type === 'run.model_activity')
          activity.setRunActivity(event.runId, {
            phase: event.phase,
            toolName: event.toolName,
            taskName: event.taskName,
          })
        else if (event.type === 'run.retrying')
          activity.setRunActivity(event.runId, {
            phase: 'waiting',
            retry: {
              attempt: event.attempt,
              maxRetries: event.maxRetries,
              reason: event.reason,
              waitMs: event.waitMs,
              startedAt: Date.now(),
            },
          })
        else if (
          event.type === 'run.completed' ||
          event.type === 'run.failed' ||
          event.type === 'run.cancelled'
        )
          activity.clearRunActivity(event.runId)
        else if (event.type === 'tool.requested')
          activity.setRunActivity(event.runId, {
            phase: 'tool',
            toolName: event.toolName,
          })
        else if (event.type === 'message.delta') {
          activity.setRunActivity(event.runId, { phase: 'answering' })
          cache.applyDelta(event.messageId, event.runId, event.delta)
        } else if (event.type === 'message.reasoning_delta') {
          activity.setRunActivity(event.runId, { phase: 'thinking' })
          cache.applyReasoningDelta(event.messageId, event.runId, event.delta)
        } else if (event.type === 'message.reset')
          cache.applyReset(event.messageId)
        else if (event.type === 'message.completed')
          cache.applyCompleted(event.messageId, event.runId, event.content)
      }),
    [],
  )
  return { ...cache, runActivities: activity.runActivities }
}
