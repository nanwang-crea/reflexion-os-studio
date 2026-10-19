import type { ProviderRequestAttempt } from '@reflexion-os-studio/contracts'
import type { RequestAttemptTracker } from './request-attempt.js'
import type { ProviderContinuation } from '@reflexion-os-studio/contracts'
import type {
  ProviderHeader,
  ReasoningEffort,
  ToolSpec,
  Usage,
} from '@reflexion-os-studio/contracts'
import type {
  ModelFinishReason,
  ModelMessage,
} from '@reflexion-os-studio/agent-core'

/** 流式聚合后的一条工具调用；arguments 为原始 JSON 字符串，由调用方校验。 */
export interface StreamedToolCall {
  id: string
  name: string
  arguments: string
}

export interface StreamChatOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** 用户配置的非鉴权附加请求头。 */
  headers?: ProviderHeader[]
  messages: ModelMessage[]
  signal: AbortSignal
  timeoutMs?: number
  /** 传入时限制补全长度（连接测试用 1，避免无谓消耗）。 */
  maxTokens?: number
  /** 采样温度；缺省由服务端决定。 */
  temperature?: number
  reasoningEffort?: ReasoningEffort
  /** 当前模型调用的请求/断流共享重试次数；传 0 禁用重试。 */
  maxRetries?: number
  retryBackoffInitialMs?: number
  retryBackoffMaxMs?: number
  /** 每次请求即将重试时调用；attempt 从 1 开始。 */
  onRetry?: (input: {
    attempt: number
    maxRetries: number
    reason: string
    /** 本次重试前的退避等待时长（毫秒）。 */
    waitMs: number
  }) => void
  /** Agent 侧 canonical 工具声明；适配层投影为各 API 方言格式。 */
  tools?: ToolSpec[]
  /** Physical request lifecycle; diagnostics contain no request payload. */
  onAttempt?: (attempt: ProviderRequestAttempt) => void
  /** Internal transport instrumentation, created once by streamChat. */
  attemptTracker?: RequestAttemptTracker
  /** Progress only; incomplete arguments must never execute. */
  onToolCallProgress?: (call: StreamedToolCall) => void
  /** Protocol-closed arguments only; parseable partial JSON is never sufficient. */
  onToolCallReady?: (call: StreamedToolCall) => void
}

export interface StreamChatResult {
  content: string
  reasoning: string
  providerContinuation?: ProviderContinuation
  /** 严格校验后的终止原因；缺失/未知值以 provider_protocol 失败，不会出现。 */
  rawStopReason?: string
  finishReason: ModelFinishReason
  usage?: Usage
  toolCalls: StreamedToolCall[]
}
