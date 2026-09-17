import type { ApiFormat } from '@reflexion-os-studio/contracts'
import { streamOpenAIChat } from './openai-chat.js'
import { streamOpenAIResponses } from './openai-responses.js'
import { streamAnthropic } from './anthropic.js'
import type { StreamChatOptions, StreamChatResult } from './types.js'

export { ProviderError } from './provider-error.js'
export type { StreamChatOptions, StreamChatResult, StreamedToolCall } from './types.js'

/**
 * 统一入口：按 apiFormat 路由到对应适配器。
 * apiFormat 缺失时向后兼容为 'openai-chat'。
 */
export async function streamChat(
  options: StreamChatOptions,
  apiFormat: ApiFormat | undefined,
  onDelta: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
): Promise<StreamChatResult> {
  const format = apiFormat ?? 'openai-chat'
  switch (format) {
    case 'openai-chat':
      return streamOpenAIChat(options, onDelta, onReasoningDelta)
    case 'openai-responses':
      return streamOpenAIResponses(options, onDelta, onReasoningDelta)
    case 'anthropic':
      return streamAnthropic(options, onDelta, onReasoningDelta)
    default:
      return streamOpenAIChat(options, onDelta, onReasoningDelta)
  }
}
