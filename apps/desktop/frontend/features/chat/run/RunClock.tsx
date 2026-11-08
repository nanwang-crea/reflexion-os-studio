import { useEffect, useState } from 'react'

/** 运行时钟只在自己的组件内每秒推进，不牵动转录区重渲染。 */
const CLOCK_INTERVAL_MS = 1000

/** 时长片段：数字用等宽字体并保持列宽，单位跟随正文字号。 */
export interface DurationPart {
  text: string
  numeric: boolean
}

/** 与 DSH 一致：分在满 60 秒后出现，小时在满 60 分后出现，秒始终显示。 */
export function formatRunDuration(ms: number): DurationPart[] {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  const parts: DurationPart[] = []
  if (hours > 0) {
    parts.push(
      { text: String(hours), numeric: true },
      { text: '小时', numeric: false },
    )
  }
  if (total >= 60) {
    parts.push(
      { text: String(minutes), numeric: true },
      { text: '分', numeric: false },
    )
  }
  parts.push(
    { text: String(seconds), numeric: true },
    { text: '秒', numeric: false },
  )
  return parts
}

/**
 * 运行中状态：蓝色“深度求索中，用时 X 分 Y 秒 ···”。
 * 位于该轮内容末尾，与思考折叠行相互独立（参考 DSH RunningStatus）。
 */
export function RunRunningStatus(props: {
  startedAtMs: number | null
}): React.JSX.Element {
  const { startedAtMs } = props
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAtMs === null) return
    setNow(Date.now())
    const timer = window.setInterval(
      () => setNow(Date.now()),
      CLOCK_INTERVAL_MS,
    )
    return () => window.clearInterval(timer)
  }, [startedAtMs])
  const parts =
    startedAtMs === null
      ? null
      : formatRunDuration(Math.max(1000, now - startedAtMs))
  return (
    <div className="run-clock" data-chat-running>
      <span className="visually-hidden" role="status" aria-live="polite">
        深度求索中
      </span>
      <span className="run-clock-text shimmer">
        {parts === null
          ? '深度求索中'
          : `深度求索中，用时 ${parts.map((part) => part.text).join('')} ···`}
      </span>
    </div>
  )
}
