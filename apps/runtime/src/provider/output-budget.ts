import type { ApiFormat } from '@reflexion-os-studio/contracts'

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096
/** 服务端默认未知时的保守预留，并非模型输出能力声明。 */
export const DEFAULT_OUTPUT_RESERVE = 4096

export function resolveOutputBudget(config: {
  apiFormat?: ApiFormat
  maxTokens?: number
}): { requestMaxTokens: number | undefined; outputReserve: number } {
  const requestMaxTokens =
    config.maxTokens ??
    (config.apiFormat === 'anthropic'
      ? DEFAULT_ANTHROPIC_MAX_TOKENS
      : undefined)
  return {
    requestMaxTokens,
    outputReserve: requestMaxTokens ?? DEFAULT_OUTPUT_RESERVE,
  }
}
