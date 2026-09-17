// 向后兼容重导出：将旧的 provider.ts 入口统一到 provider/ 目录。
export { ProviderError } from './provider/provider-error.js'
export type {
  StreamChatOptions,
  StreamChatResult,
  StreamedToolCall,
} from './provider/types.js'
export { streamChat } from './provider/index.js'

import type { StreamChatOptions, StreamChatResult } from './provider/types.js'
import { streamChat } from './provider/index.js'

/**
 * 向后兼容包装：保持旧的 streamChatCompletion 签名。
 * 旧调用方不传 apiFormat，走默认 'openai-chat'。
 */
export async function streamChatCompletion(
  options: StreamChatOptions,
  onDelta: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
): Promise<StreamChatResult> {
  return streamChat(options, undefined, onDelta, onReasoningDelta)
}
