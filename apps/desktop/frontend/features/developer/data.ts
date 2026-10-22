import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeDeveloperChanges } from '../../api/developer'

/** Page-local subscription: no delta listeners, polling or idle timers. */
export function useDeveloperRefresh() {
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const relevant = new Set([
      'developer.updated',
      'run.started',
      'run.completed',
      'run.failed',
      'run.cancelled',
      'tool.completed',
      'message.completed',
      'message.attempt',
      'session.updated',
    ])
    const unsubscribe = subscribeDeveloperChanges((event) => {
      if (!relevant.has(event.type) || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        setRevision((value) => value + 1)
      }, 300)
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [])
  return { revision, refresh }
}

/** Serialize refreshes for one query, and discard responses only when its key changes. */
export function useDeveloperQuery<T>(
  load: () => Promise<T>,
  revision: number,
  enabled = true,
) {
  const [state, setState] = useState<{
    data: T | null
    error: string | null
    loading: boolean
  }>({ data: null, error: null, loading: true })
  const refreshRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    let active = true
    let pending = false
    let running = false
    setState({ data: null, error: null, loading: true })
    const refresh = async () => {
      pending = true
      if (running) return
      running = true
      while (active && pending) {
        pending = false
        setState((current) => ({ ...current, error: null, loading: true }))
        try {
          const data = await load()
          if (active) setState({ data, error: null, loading: false })
        } catch (error) {
          if (active)
            setState({
              data: null,
              error: error instanceof Error ? error.message : String(error),
              loading: false,
            })
        }
      }
      running = false
    }
    refreshRef.current = () => {
      void refresh()
    }
    return () => {
      active = false
      refreshRef.current = null
    }
  }, [load])
  useEffect(() => {
    if (enabled) refreshRef.current?.()
  }, [load, revision, enabled])
  return state
}
