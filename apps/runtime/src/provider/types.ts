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
  /** 请求建立阶段失败自动重试次数；连接测试等场景传 0 快速失败。 */
  maxRetries?: number
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
}

export interface StreamChatResult {
  content: string
  reasoning: string
  /** 严格校验后的终止原因；缺失/未知值以 provider_protocol 失败，不会出现。 */
  rawStopReason?: string
  finishReason: ModelFinishReason
  usage?: Usage
  toolCalls: StreamedToolCall[]
}
