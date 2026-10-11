import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BrowserAction,
  BrowserSnapshot,
} from '@reflexion-os-studio/runtime-client'
import { browserSurface } from '../../api/browser'

export function useBrowserSurface(visible = true) {
  const [state, setState] = useState<BrowserSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [slowLoad, setSlowLoad] = useState(false)
  const revision = useRef(-1)
  const accept = useCallback((next: BrowserSnapshot) => {
    if (next.revision < revision.current) return
    revision.current = next.revision
    setState(next)
  }, [])
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void browserSurface
      .subscribe((next) => {
        if (!disposed) accept(next)
      })
      .then(async (cleanup) => {
        if (disposed) {
          cleanup()
          return
        }
        unlisten = cleanup
        const next = await browserSurface.control({ kind: 'status' })
        if (!disposed) accept(next)
      })
      .catch((caught: unknown) => {
        if (!disposed) setError(String(caught))
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [accept])
  useEffect(() => {
    if (!visible) return
    let disposed = false
    void browserSurface
      .control({ kind: 'attach' })
      .then((next) => {
        if (!disposed) accept(next)
      })
      .catch((caught: unknown) => {
        if (!disposed) setError(String(caught))
      })
    return () => {
      disposed = true
    }
  }, [visible, accept])
  // A bounded one-shot per navigation, never a polling/idle heartbeat.
  useEffect(() => {
    setSlowLoad(false)
    if (state?.status !== 'loading') return
    const timer = setTimeout(() => setSlowLoad(true), 30_000)
    return () => clearTimeout(timer)
  }, [state?.status, state?.url])
  const control = useCallback(
    async (action: BrowserAction) => {
      setError(null)
      try {
        accept(await browserSurface.control(action))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [accept],
  )
  const navigate = useCallback(
    async (url: string) => {
      setError(null)
      try {
        if (state?.available === false) await browserSurface.openExternal(url)
        else accept(await browserSurface.control({ kind: 'navigate', url }))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [accept, state?.available],
  )
  const external = useCallback(async (url: string) => {
    setError(null)
    try {
      await browserSurface.openExternal(url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])
  return {
    state,
    error:
      error ??
      (slowLoad && state?.status === 'loading'
        ? '加载时间较长，可停止加载或使用系统浏览器'
        : null),
    control,
    navigate,
    external,
  }
}
