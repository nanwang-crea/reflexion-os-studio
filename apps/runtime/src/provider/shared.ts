import type { RuntimeErrorCode } from '@reflexion-os-studio/contracts'

const DEFAULT_TIMEOUT_MS = 120_000
/** 请求建立阶段失败(网络/限流/服务端短暂故障)的自动重试次数与退避。 */
const DEFAULT_MAX_RETRIES = 5
/** 重试退避公式：1s 起步 ×2 递增，封顶 60s；适配任意 maxRetries（设置范围 0–15）。 */
const RETRY_BACKOFF_BASE_MS = 1_000
const RETRY_BACKOFF_CAP_MS = 60_000

export function retryBackoffMs(attempt: number): number {
  return Math.min(
    RETRY_BACKOFF_CAP_MS,
    RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1),
  )
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES }

/** 429 限流与 5xx 短暂故障可重试；认证/配置类错误重试无意义。 */
export function shouldRetryStatus(code: number, detail = ''): boolean {
  if (code === 429 || code >= 500) return true
  if (code !== 400) return false
  try {
    const parsed = JSON.parse(detail) as {
      error?: { type?: unknown; code?: unknown; message?: unknown }
    }
    const values = [
      parsed.error?.type,
      parsed.error?.code,
      parsed.error?.message,
    ]
    return values.some(
      (value) =>
        typeof value === 'string' &&
        /temporary|overload|try again|temporarily unavailable/i.test(value),
    )
  } catch {
    return false
  }
}

/** 可取消的等待；signal 已中止时立即抛 AbortError。 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function mapHttpStatus(code: number): RuntimeErrorCode {
  if (code === 401 || code === 403) return 'authentication'
  if (code === 429) return 'rate_limit'
  if (code === 404) return 'configuration'
  if (code >= 500) return 'provider'
  return 'configuration'
}

export function mapFinishReason(
  reason: string | null | undefined,
): 'stop' | 'length' | 'content_filter' | 'tool_calls' | null {
  if (
    reason === 'stop' ||
    reason === 'length' ||
    reason === 'content_filter' ||
    reason === 'tool_calls'
  ) {
    return reason
  }
  return null
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

export class StreamCallbackError extends Error {
  constructor(cause: unknown) {
    super(String(cause))
    this.name = 'StreamCallbackError'
    this.cause = cause
  }

  readonly cause: unknown
}

/**
 * 部分 Provider(如某些聚合/中转服务)只接受 a-z A-Z 0-9 _ - 的工具名，
 * 而内部 canonical 名含点号(web.fetch)或斜杠(MCP 的 serverId/toolName)。
 * 在 Provider 方言边界做一次确定性清洗，并维护 清洗名 ⇄ 原始名 双向映射。
 */
const SAFE_NAME_RE = /[^a-zA-Z0-9_-]/g
const MAX_SAFE_NAME_LEN = 64

export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(SAFE_NAME_RE, '_')
  return (cleaned === '' ? '_' : cleaned).slice(0, MAX_SAFE_NAME_LEN)
}

export interface ToolNameMapping {
  canonicalToProvider: Map<string, string>
  providerToCanonical: Map<string, string>
}

/**
 * 构建 canonical 名 ⇄ Provider 清洗名的双向映射：同一请求内固定，只构建一次。
 * 清洗后可能重名(canonical 点号/斜杠不同但清洗结果相同)，冲突时追加数字后缀。
 */
export function buildToolNameMapping(
  toolNames: string[],
  messageToolNames: string[],
): ToolNameMapping {
  const canonicalToProvider = new Map<string, string>()
  const providerToCanonical = new Map<string, string>()
  const usedNames = new Set<string>()
  const canonicalNames = new Set([...toolNames, ...messageToolNames])

  for (const canonicalName of canonicalNames) {
    let safeName = sanitizeToolName(canonicalName)
    let suffix = 2
    while (usedNames.has(safeName)) {
      const suffixText = `_${suffix}`
      const base = sanitizeToolName(canonicalName).slice(
        0,
        MAX_SAFE_NAME_LEN - suffixText.length,
      )
      safeName = `${base}${suffixText}`
      suffix += 1
    }
    usedNames.add(safeName)
    canonicalToProvider.set(canonicalName, safeName)
    providerToCanonical.set(safeName, canonicalName)
  }

  return { canonicalToProvider, providerToCanonical }
}
