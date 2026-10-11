import { userImageContent } from '../image-content.js'
import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import type { StreamChatOptions } from '../types.js'

/**
 * canonical ModelMessage 投影为 OpenAI chat 方言：
 * assistant 的工具调用回到 tool_calls 数组，工具结果走 role=tool + tool_call_id。
 */
function toProviderMessage(
  message: ModelMessage,
  canonicalToProvider: ReadonlyMap<string, string>,
): Record<string, unknown> {
  switch (message.role) {
    case 'system':
      return { role: message.role, content: message.content }
    case 'user':
      return { role: 'user', content: userImageContent(message, 'openai-chat') }
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: canonicalToProvider.get(call.name) ?? call.name,
                  arguments: call.arguments,
                },
              })),
            }
          : {}),
      }
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      }
  }
}

export function chatRequestBody(
  options: StreamChatOptions,
  canonicalToProvider: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const tools = options.tools
  return {
    model: options.model,
    messages: options.messages.map((message) =>
      toProviderMessage(message, canonicalToProvider),
    ),
    stream: true,
    ...(options.reasoningEffort !== undefined
      ? { reasoning_effort: options.reasoningEffort }
      : {}),
    stream_options: { include_usage: true },
    ...(options.maxTokens !== undefined
      ? { max_tokens: options.maxTokens }
      : {}),
    ...(options.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(tools !== undefined && tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: canonicalToProvider.get(tool.name) ?? tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }
      : {}),
  }
}
