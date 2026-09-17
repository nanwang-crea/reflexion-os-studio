import type { RuntimeErrorCode } from '@reflexion-os-studio/contracts'

export class ProviderError extends Error {
  readonly code: RuntimeErrorCode

  constructor(code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}
