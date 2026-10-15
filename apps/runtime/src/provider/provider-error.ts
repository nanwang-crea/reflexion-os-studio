import type { RuntimeErrorCode } from '@reflexion-os-studio/contracts'

export class ProviderError extends Error {
  readonly code: RuntimeErrorCode

  constructor(code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

/** Redact before truncation so even a long credential cannot leak as a prefix. */
export function redactProviderError(value: unknown, apiKey: string): string {
  const text = String(value)
  return apiKey ? text.split(apiKey).join('[redacted]') : text
}
