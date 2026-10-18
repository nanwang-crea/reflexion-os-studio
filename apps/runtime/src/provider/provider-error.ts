import type { ProviderHeader } from '@reflexion-os-studio/contracts'
import type { RuntimeErrorCode } from '@reflexion-os-studio/contracts'

export class ProviderError extends Error {
  readonly code: RuntimeErrorCode

  constructor(
    code: RuntimeErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

/** Redact before truncation so even a long credential cannot leak as a prefix. */
export function redactProviderError(
  value: unknown,
  apiKey: string,
  headers?: ProviderHeader[],
): string {
  let text = String(value)
  const secrets = [apiKey, ...(headers ?? []).map((header) => header.value)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  for (const secret of secrets) text = text.split(secret).join('[redacted]')
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]')
}

/** Only the message field is exposed, never an arbitrary provider error object. */
export function providerStreamError(
  value: unknown,
  options: {
    apiKey: string
    headers?: ProviderHeader[]
  },
): ProviderError {
  const record =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined
  const message =
    record?.message ??
    (typeof value === 'string' ? value : 'unknown provider error')
  const kind = [record?.type, record?.code].map(String).join(' ')
  const transient =
    /rate_limit|overload|temporar|server_error|capacity/i.test(kind) ||
    /overloaded|temporarily unavailable/i.test(String(message))
  const code = /auth|api_key|permission|\b40[13]\b/i.test(kind)
    ? 'authentication'
    : /rate_limit|\b429\b/i.test(kind)
      ? 'rate_limit'
      : 'provider'
  return new ProviderError(
    code,
    `provider stream error: ${redactProviderError(message, options.apiKey, options.headers).slice(0, 200)}`,
    code !== 'authentication' &&
      (transient || /\b(408|429|5[0-9]{2})\b/.test(kind)),
  )
}
