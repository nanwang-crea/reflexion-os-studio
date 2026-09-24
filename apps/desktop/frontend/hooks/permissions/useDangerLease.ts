import { useCallback, useEffect, useState } from 'react'
import type {
  DangerAccessLease,
  RuntimeEvent,
} from '@reflexion-os-studio/runtime-client'
import { dangerStatus } from '../../api/permissions'

type DangerChangedEvent = Extract<RuntimeEvent, { type: 'danger.changed' }>

/**
 * Danger 租约前端投影：Runtime 是唯一真源。事件（danger.changed）驱动更新，
 * 会话切换/挂载时经 danger.status 对账（webview 重载后不丢状态）。
 * 只保存当前关注会话的租约；其它会话的租约由 Runtime 独立管理。
 */
export function useDangerLease(activeSessionId: string | null): {
  lease: DangerAccessLease | null
  onDangerChanged: (event: DangerChangedEvent) => void
} {
  const [lease, setLease] = useState<DangerAccessLease | null>(null)

  useEffect(() => {
    let cancelled = false
    setLease(null)
    if (activeSessionId === null) return
    void dangerStatus(activeSessionId)
      .then((result) => {
        if (!cancelled) setLease(result.lease)
      })
      .catch(() => {
        // 对账失败保持空态：Runtime 侧无租约即无提权（fail-closed 方向）。
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId])

  const onDangerChanged = useCallback(
    (event: DangerChangedEvent): void => {
      if (event.sessionId !== activeSessionId) return
      setLease(event.lease)
    },
    [activeSessionId],
  )

  return { lease, onDangerChanged }
}
