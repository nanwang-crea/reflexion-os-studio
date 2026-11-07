import {
  estimateMessageTokens,
  estimateTokens,
  type ModelMessage,
} from '@reflexion-os-studio/agent-core'
import type {
  ApiFormat,
  ProviderHeader,
  ReasoningEffort,
  ToolSpec,
} from '@reflexion-os-studio/contracts'
import { resolveOutputBudget } from '../../provider/output-budget.js'
import { ProviderError } from '../../provider/provider-error.js'

/**
 * 上下文预算上限（token 数）：超过即触发摘要压缩。
 * 模型窗口更大时仍以该值为上限；可在 Provider 设置中按供应商标定。
 */
export const DEFAULT_CONTEXT_BUDGET_LIMIT = 64_000

export interface ProviderRuntimeConfig {
  providerId?: string
  baseUrl: string
  apiKey: string
  model: string
  /** API 协议格式；缺失时向后兼容为 'openai-chat'。 */
  apiFormat?: ApiFormat
  headers?: ProviderHeader[]
  /** 缺省由服务端决定。 */
  temperature?: number
  reasoningEffort?: ReasoningEffort
  maxTokens?: number
  /** 模型上下文窗口（token 数）；未知时用预算上限。 */
  contextWindow?: number
  /** 上下文预算上限（token 数）；缺省 DEFAULT_CONTEXT_BUDGET_LIMIT。 */
  contextBudget?: number
  /** 请求建立阶段重试次数；缺省 provider 内置(5)。 */
  maxRetries?: number
  retryBackoffInitialMs?: number
  retryBackoffMaxMs?: number
  /** 请求超时(毫秒)；缺省 provider 内置(120s)。 */
  timeoutMs?: number
}

/**
 * 上下文预算：min(预算上限, 窗口 × 0.75 − maxTokens 预留),为输出留足空间;
 * 下限 1024 防止小配置把预算压死。窗口未知时直接用预算上限。
 */
export function contextBudgetFor(
  provider: ProviderRuntimeConfig,
  tools: readonly ToolSpec[] = [],
): number {
  const limit = provider.contextBudget ?? DEFAULT_CONTEXT_BUDGET_LIMIT
  const window = provider.contextWindow
  if (window === undefined || window === null || window <= 0) {
    return Math.max(0, limit - estimateToolTokens(tools))
  }
  const { outputReserve } = resolveOutputBudget(provider)
  const windowBudget = Math.floor(window * 0.75) - outputReserve
  return Math.max(
    0,
    Math.max(1024, Math.min(limit, windowBudget)) - estimateToolTokens(tools),
  )
}

/** Includes JSON schema/name/description and a small provider serialization allowance. */
export function estimateToolTokens(tools: readonly ToolSpec[]): number {
  return tools.length === 0
    ? 0
    : estimateTokens(JSON.stringify(tools)) + tools.length * 12
}

/** 最大几个工具 schema 的占比：工具 schema 常年占预算大头，排障需要定位来源。 */
export function toolSchemaBreakdown(
  tools: readonly ToolSpec[],
  limit = 3,
): string {
  return tools
    .map((tool) => ({
      name: tool.name,
      tokens: estimateTokens(JSON.stringify(tool)),
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit)
    .map((entry) => `${entry.name}:${entry.tokens}`)
    .join(',')
}

export function estimateRequestInputTokens(
  messages: ModelMessage[],
  tools: readonly ToolSpec[],
): number {
  return (
    estimateMessageTokens(messages) +
    estimateToolTokens(tools) +
    messages.length * 8 +
    32
  )
}

/** Soft budgets guide trimming; only a known model window rejects the final request. */
export function checkRequestBudget(
  messages: ModelMessage[],
  provider: ProviderRuntimeConfig,
  tools: readonly ToolSpec[] = [],
): void {
  const estimated = estimateRequestInputTokens(messages, tools)
  if (provider.contextWindow != null && provider.contextWindow > 0) {
    const { outputReserve } = resolveOutputBudget(provider)
    if (estimated + outputReserve > provider.contextWindow) {
      // 失败时指出固定开销来源：只报“输入过长”会让用户误以为历史可以再删。
      const toolTokens = estimateToolTokens(tools)
      const systemTokens =
        messages[0]?.role === 'system' ? estimateTokens(messages[0].content) : 0
      const composition =
        systemTokens > 0 || toolTokens > 0
          ? `（其中 system 提示约 ${systemTokens} token，工具 schema 约 ${toolTokens} token）`
          : ''
      throw new ProviderError(
        'configuration',
        `模型上下文窗口不足：估算输入 ${estimated} token${composition}，输出预留 ${outputReserve} token，窗口 ${provider.contextWindow} token。请缩短本次输入、减少工具，或检查模型窗口与输出参数。`,
      )
    }
  }
  const softLimit = contextBudgetFor(provider) // already includes output reserve, but not tools
  if (estimated > softLimit)
    process.stderr.write(
      `[metrics] contextSoftBudgetExceeded:true estimatedInputTokens:${estimated} softBudget:${softLimit} toolSchemaTokens:${estimateToolTokens(tools)} toolSchemaTop:${toolSchemaBreakdown(tools)}\n`,
    )
}
