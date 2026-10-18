import { useCallback, useEffect, useRef, useState } from 'react'
import {
  subscribeBrowserNavigation,
  type BrowserNavigationCompletion,
} from '../../api/browser-navigation'
import { setBrowserPanelOpen } from './panel-state'

export function useBrowserNavigationFailure(sessionId: string | null) {
  const currentSession = useRef(sessionId)
  const lastCall = useRef<string | null>(null)
  const [failure, setFailure] = useState<BrowserNavigationCompletion | null>(
    null,
  )
  useEffect(() => {
    currentSession.current = sessionId
    lastCall.current = null
    setFailure(null)
  }, [sessionId])
  useEffect(
    () =>
      subscribeBrowserNavigation((event) => {
        const target = currentSession.current
        if (
          !target ||
          ![
            event.navigation.sessionId,
            event.navigation.rootSessionId,
          ].includes(target)
        )
          return
        if (lastCall.current === event.toolCallId) return
        lastCall.current = event.toolCallId
        if (event.status === 'completed') setFailure(null)
        else if (event.status === 'failed') {
          setFailure(event)
          setBrowserPanelOpen(true)
        }
      }),
    [],
  )
  const dismiss = useCallback(() => setFailure(null), [])
  const visible =
    failure &&
    [failure.navigation.sessionId, failure.navigation.rootSessionId].includes(
      sessionId ?? '',
    )
      ? failure
      : null
  return { failure: visible, dismiss }
}
