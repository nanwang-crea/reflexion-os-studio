import { userImageContent } from '../image-content.js'
import { bindReplayCalls, continuationMatches } from '../continuation.js'
import type { StreamChatOptions } from '../types.js'

/**
 * canonical ModelMessage 投影为 OpenAI Responses API input 格式：
 * system 消息提取为 instructions，assistant 的工具调用保留为 function_call，
 * 工具结果走 function_call_output。
 */
export function toResponsesInput(
  options: StreamChatOptions,
  canonicalToProvider: ReadonlyMap<string, string>,
): {
  instructions: string | undefined
  input: Array<Record<string, unknown>>
} {
  let instructions: string | undefined
  const input: Array<Record<string, unknown>> = []

  const aliases = new Map<string, string>()
  for (const message of options.messages) {
    if (message.role === 'system') {
      instructions = instructions
        ? `${instructions}\n${message.content}`
        : message.content
      continue
    }
    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: userImageContent(message, 'openai-responses'),
      })
      continue
    }
    if (message.role === 'assistant') {
      const replay = message.providerContinuation
      if (
        replay?.apiFormat === 'openai-responses' &&
        continuationMatches(replay, options)
      ) {
        bindReplayCalls(
          message,
          replay.items
            .filter((item) => item.type === 'function_call')
            .map((item) => item.call_id),
          aliases,
        )
        input.push(...replay.items)
        continue
      }
      if (!message.content && message.toolCalls.length === 0) continue
      if (message.toolCalls.length === 0) {
        input.push({ role: 'assistant', content: message.content })
      } else {
        // 文本部分
        if (message.content) {
          input.push({ role: 'assistant', content: message.content })
        }
        // 工具调用部分
        for (const call of message.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: canonicalToProvider.get(call.name) ?? call.name,
            arguments: call.arguments,
          })
        }
      }
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: aliases.get(message.toolCallId) ?? message.toolCallId,
        output: message.content,
      })
    }
  }

  return { instructions, input }
}
