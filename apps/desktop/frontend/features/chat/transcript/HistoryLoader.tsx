import { useState, useRef } from 'react'
import type { HistoryCursor } from '@reflexion-os-studio/runtime-client'

interface Props {
  sessionId: string
  before: HistoryCursor
  onLoad: (sessionId: string, before: HistoryCursor) => Promise<void>
  onStart?: () => void
}

export function HistoryLoader({
  sessionId,
  before,
  onLoad,
  onStart,
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const load = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    onStart?.()
    try {
      await onLoad(sessionId, before)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <div className="history-loader">
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy ? '加载中…' : '加载更早的 10 轮对话'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
