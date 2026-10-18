import { createRequestAttemptTracker } from './request-attempt.js'
import { StreamCallbackError } from './shared.js'
import type { ApiFormat } from '@reflexion-os-studio/contracts'
import { streamOpenAIChat } from './openai-chat.js'
import { streamOpenAIResponses } from './openai-responses.js'
import { streamAnthropic } from './anthropic.js'
import type { StreamChatOptions, StreamChatResult } from './types.js'

export { ProviderError } from './provider-error.js'
export type {
  StreamChatOptions,
  StreamChatResult,
  StreamedToolCall,
} from './types.js'

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
  const tracker = createRequestAttemptTracker(options)
  const instrumented = { ...options, attemptTracker: tracker }
  try {
    const adapter =
      apiFormat === 'anthropic'
        ? streamAnthropic
        : apiFormat === 'openai-responses'
          ? streamOpenAIResponses
          : streamOpenAIChat
    const result = await adapter(
      instrumented,
      (delta) => {
        if (delta) tracker.content('text')
        onDelta(delta)
      },
      (delta) => {
        if (delta) tracker.content('reasoning')
        onReasoningDelta?.(delta)
      },
    )
    tracker.finish('completed')
    return result
  } catch (error) {
    tracker.finish('failed', error)
    throw error instanceof StreamCallbackError ? error.cause : error
  }
}
