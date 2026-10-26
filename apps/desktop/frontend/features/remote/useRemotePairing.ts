import { useCallback, useEffect, useState } from 'react'
import type { RemoteDevice } from '@reflexion-os-studio/contracts'
import { getRemoteTransport } from '../../lib/transport'

export function useRemotePairing() {
  const [device, setDevice] = useState<RemoteDevice | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [invitation] = useState(() => {
    const value = new URLSearchParams(location.hash.slice(1)).get('invitation')
    if (value) history.replaceState(null, '', location.pathname)
    return value
  })
  const pair = useCallback(
    async (name: string): Promise<void> => {
      if (!invitation) {
        setError('请扫描电脑上的新二维码')
        return
      }
      setBusy(true)
      try {
        const state = await getRemoteTransport().pair(invitation, name)
        setDevice(state.device)
        setSessionId(state.sessionId)
        setError(null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '配对失败')
      } finally {
        setBusy(false)
      }
    },
    [invitation],
  )
  const deviceId = device?.id
  const approved = device?.approved
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const restore = async (): Promise<void> => {
      try {
        const state = await getRemoteTransport().pairState()
        if (disposed) return
        setDevice(state.device)
        setSessionId(state.sessionId)
        setError(null)
        if (!state.device.approved)
          timer = setTimeout(() => void restore(), 1500)
      } catch {
        if (!disposed && deviceId)
          setError('配对已过期或被拒绝，请扫描新二维码')
      }
    }
    if (!invitation || deviceId) void restore()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [invitation, deviceId, approved])
  return { device, sessionId, error, busy, pair }
}
