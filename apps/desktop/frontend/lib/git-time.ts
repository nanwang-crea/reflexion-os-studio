/** 分钟/小时/天的毫秒数，供相对时间分档。 */
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 提交时间的相对化展示（纯函数，不读系统时钟）：
 * <1 小时→「n 分钟前」，<24 小时→「n 小时前」，<7 天→「n 天前」，
 * 否则按本地日期输出 YYYY-MM-DD。未来时间戳按 0 分钟前处理。
 */
export function formatRelativeTime(timestampMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - timestampMs)
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`
  const date = new Date(timestampMs)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}
