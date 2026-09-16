import { useEffect, useState } from 'react'
import type { DangerAccessLease } from '@reflexion-os-studio/runtime-client'

/** 常驻红色状态条：Danger 租约激活期间不可忽略，显示剩余时间与立即关闭。 */
export function DangerLeaseBanner({
  lease,
  onDisable,
}: {
  lease: DangerAccessLease
  onDisable: () => void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const remainingMs = Math.max(0, lease.expiresAt - now)
  const minutes = Math.floor(remainingMs / 60_000)
  const seconds = Math.floor((remainingMs % 60_000) / 1000)
  return (
    <div
      className="danger-lease-banner"
      role="status"
      aria-label="危险访问已启用"
    >
      <span className="danger-icon" aria-hidden>
        ☠
      </span>
      <span className="danger-text">
        危险访问已启用（系统范围 · {lease.provider}）· 剩余{' '}
        {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
        <span className="danger-sub">机密拒读与日志脱敏仍然生效</span>
      </span>
      <button type="button" className="danger-disable" onClick={onDisable}>
        立即关闭
      </button>
    </div>
  )
}
