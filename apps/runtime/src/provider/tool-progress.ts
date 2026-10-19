import { StreamCallbackError } from './shared.js'
import type { StreamChatOptions, StreamedToolCall } from './types.js'

export function reportToolProgress(
  options: StreamChatOptions,
  call: StreamedToolCall,
): void {
  try {
    options.onToolCallProgress?.({ ...call })
  } catch (error) {
    throw new StreamCallbackError(error)
  }
}

export function reportToolReady(
  options: StreamChatOptions,
  call: StreamedToolCall,
): void {
  try {
    options.onToolCallReady?.({ ...call })
  } catch (error) {
    throw new StreamCallbackError(error)
  }
}
