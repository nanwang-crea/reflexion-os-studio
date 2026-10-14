import { useCallback, useEffect, useRef, useState } from 'react'
import type { Delegation } from '@reflexion-os-studio/runtime-client'
import { getDelegationTree } from '../../../api/agents'
import { transport } from '../../../lib/transport'

/** The saved delegation tree is canonical; events invalidate it without idle polling. */
export function useCollaborationTree(rootRunId: string | null) {
  const [items, setItems] = useState<Delegation[]>([])
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const refresh = useCallback(async () => {
    if (!rootRunId) return
    const request = ++epoch.current
    try {
      const next = await getDelegationTree(rootRunId)
      if (request === epoch.current) {
        setItems(next)
        setError(null)
      }
    } catch (error) {
      if (request === epoch.current) setError(String(error))
    }
  }, [rootRunId])
  const latest = useRef({ rootRunId, refresh })
  latest.current = { rootRunId, refresh }
  const invalidate = useCallback(() => {
    epoch.current++
  }, [])
  useEffect(() => {
    setItems([])
    setError(null)
    void refresh()
    return invalidate
  }, [refresh, invalidate])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = transport.onEvent((event) => {
      if (
        (event.type !== 'delegation.created' &&
          event.type !== 'delegation.updated') ||
        (event.delegation.rootRunId ?? event.delegation.parentRunId) !==
          latest.current.rootRunId
      )
        return
      timer ??= setTimeout(() => {
        timer = undefined
        void latest.current.refresh()
      }, 32)
    })
    return () => {
      dispose()
      clearTimeout(timer)
    }
  }, [])
  return { items, error, refresh }
}
