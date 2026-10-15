import type { ContextFrame } from '../frames.js'
import { estimateTokens } from '../context.js'

/** Frame 级 token 估算：工具轮计入 arguments 与全部结果文本。 */
export function estimateFrameTokens(frames: ContextFrame[]): number {
  let total = 0
  for (const frame of frames) {
    switch (frame.kind) {
      case 'system':
      case 'user':
      case 'assistant_text':
      case 'runtime_control':
        total +=
          estimateTokens(frame.content) +
          (frame.kind === 'user' ? (frame.images?.length ?? 0) * 4096 : 0) +
          (frame.kind === 'assistant_text'
            ? estimateTokens(
                frame.providerContinuation
                  ? JSON.stringify(frame.providerContinuation)
                  : (frame.reasoning ?? ''),
              )
            : 0)
        break
      case 'tool_round': {
        total +=
          estimateTokens(frame.assistant.content) +
          estimateTokens(
            frame.assistant.providerContinuation
              ? JSON.stringify(frame.assistant.providerContinuation)
              : (frame.assistant.reasoning ?? ''),
          )
        for (const call of frame.assistant.toolCalls) {
          total += estimateTokens(call.arguments)
        }
        for (const result of frame.results) {
          total += estimateTokens(result.content)
        }
        break
      }
    }
  }
  return total
}
