import { userImageContent } from '../image-content.js'
import { bindReplayCalls, continuationMatches } from '../continuation.js'
import type { StreamChatOptions } from '../types.js'

export function toAnthropicMessages(
  options: StreamChatOptions,
  canonicalToProvider: ReadonlyMap<string, string>,
): { system: string | undefined; messages: Array<Record<string, unknown>> } {
  let system: string | undefined
  const messages: Array<Record<string, unknown>> = []
  const aliases = new Map<string, string>()
  for (const message of options.messages) {
    if (message.role === 'system') {
      system = system ? `${system}\n${message.content}` : message.content
    } else if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: userImageContent(message, 'anthropic'),
      })
    } else if (message.role === 'assistant') {
      const replay = message.providerContinuation
      if (
        replay?.apiFormat === 'anthropic' &&
        continuationMatches(replay, options)
      ) {
        bindReplayCalls(
          message,
          replay.blocks
            .filter((block) => block.type === 'tool_use')
            .map((block) => block.id),
          aliases,
        )
        messages.push({ role: 'assistant', content: replay.blocks })
        continue
      }
      if (!message.content && message.toolCalls.length === 0) continue
      const content: Array<Record<string, unknown>> = []
      if (message.content) content.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls) {
        let input: unknown = {}
        try {
          input = JSON.parse(call.arguments)
        } catch {
          /* 保持既有非法参数降级。 */
        }
        content.push({
          type: 'tool_use',
          id: call.id,
          name: canonicalToProvider.get(call.name) ?? call.name,
          input,
        })
      }
      messages.push({
        role: 'assistant',
        content: content.length ? content : message.content,
      })
    } else {
      const block = {
        type: 'tool_result',
        tool_use_id: aliases.get(message.toolCallId) ?? message.toolCallId,
        content: message.content,
        is_error: message.isError,
      }
      const previous = messages.at(-1)
      if (
        previous?.role === 'user' &&
        Array.isArray(previous.content) &&
        previous.content.every((part) => part.type === 'tool_result')
      ) {
        previous.content.push(block)
      } else {
        messages.push({ role: 'user', content: [block] })
      }
    }
  }
  return { system, messages }
}
