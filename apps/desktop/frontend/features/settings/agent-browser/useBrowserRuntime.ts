import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentBrowserRuntime } from '@reflexion-os-studio/contracts'
import {
  getAgentBrowserRuntime,
  installAgentBrowserRuntime,
  cancelAgentBrowserRuntime,
} from '../../../api/agent-browser-settings'

export function useBrowserRuntime() {
  const [runtime, setRuntime] = useState<AgentBrowserRuntime | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const sequence = useRef(0)
  const acting = useRef(false)
  const refresh = useCallback(async () => {
    if (!mounted.current || acting.current) return
    const request = ++sequence.current
    try {
      const result = await getAgentBrowserRuntime()
      if (mounted.current && request === sequence.current) {
        setRuntime(result)
        setError(null)
      }
    } catch {
      if (mounted.current && request === sequence.current)
        setError('无法读取浏览器组件状态，请重新检查。')
    }
  }, [])
  const deactivate = useCallback(() => {
    mounted.current = false
    ++sequence.current
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    return deactivate
  }, [refresh, deactivate])
  const downloading = runtime?.state === 'downloading'
  useEffect(() => {
    if (!downloading) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh()
      if (active) timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [downloading, refresh])
  const act = useCallback(async (action: 'install' | 'cancel' | 'refresh') => {
    if (!mounted.current || acting.current) return
    acting.current = true
    const request = ++sequence.current
    setBusy(true)
    setError(null)
    try {
      const result = await (action === 'install'
        ? installAgentBrowserRuntime()
        : action === 'cancel'
          ? cancelAgentBrowserRuntime()
          : getAgentBrowserRuntime())
      if (mounted.current && request === sequence.current) setRuntime(result)
    } catch {
      if (mounted.current && request === sequence.current)
        setError('操作失败，请重试。')
    } finally {
      acting.current = false
      if (mounted.current && request === sequence.current) setBusy(false)
    }
  }, [])
  return { runtime, busy, error, act, downloading }
}
