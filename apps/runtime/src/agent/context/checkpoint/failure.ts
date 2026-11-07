/**
 * Checkpoint 刷新失败诊断与退避。
 *
 * 来源 hash 会随历史增长不断变化，只按 hash 冷却无法阻止每次 Run 都重新
 * 摘要（实测单会话一天内重复 32K 输入摘要多次）。这里按会话累计连续失败：
 * 1 次后 1 分钟、2 次后 2 分钟……封顶 15 分钟；成功即清零。
 */

export const CHECKPOINT_SESSION_BACKOFF_BASE_MS = 60_000
export const CHECKPOINT_SESSION_BACKOFF_MAX_MS = 15 * 60_000
const MAX_SESSION_FAILURES = 256

const sessionFailures = new Map<
  string,
  { failures: number; retryAfter: number }
>()

export function sessionBackoffActive(
  sessionId: string,
  now = Date.now(),
): boolean {
  const entry = sessionFailures.get(sessionId)
  return entry !== undefined && entry.retryAfter > now
}

export function recordSessionFailure(sessionId: string): void {
  const previous = sessionFailures.get(sessionId)
  const failures = (previous?.failures ?? 0) + 1
  const delay = Math.min(
    CHECKPOINT_SESSION_BACKOFF_MAX_MS,
    CHECKPOINT_SESSION_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 6),
  )
  sessionFailures.delete(sessionId)
  sessionFailures.set(sessionId, {
    failures,
    retryAfter: Date.now() + delay,
  })
  if (sessionFailures.size > MAX_SESSION_FAILURES) {
    const oldest = sessionFailures.keys().next().value
    if (oldest !== undefined) sessionFailures.delete(oldest)
  }
}

export function clearSessionFailure(sessionId: string): void {
  sessionFailures.delete(sessionId)
}

export function clearAllSessionFailures(): void {
  sessionFailures.clear()
}

/** 失败原因只保留稳定分类码：不把模型输出/Provider 细节写进日志。 */
export function classifyCheckpointError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^(authentication|rate_limit|timeout|network|provider|provider_protocol|configuration)$/.test(
      error.code,
    )
  )
    return `provider_${error.code}`
  const message = error instanceof Error ? error.message : ''
  if (message.includes('output truncated')) return 'summary_truncated'
  if (message.includes('did not complete as text')) return 'summary_incomplete'
  if (message.includes('no JSON object')) return 'summary_no_json'
  if (message.includes('invalid schema')) return 'summary_schema'
  if (message.includes('empty result')) return 'summary_empty'
  if (message.includes('too many input batches'))
    return 'summary_too_many_batches'
  if (message.includes('prior summary exceeds')) return 'summary_over_budget'
  if (message.includes('no input space')) return 'summary_over_budget'
  if (message.includes('no source content')) return 'summary_no_source'
  if (message.includes('source changed')) return 'source_changed'
  if (message.includes('failed hash')) return 'cooldown'
  return 'internal'
}
