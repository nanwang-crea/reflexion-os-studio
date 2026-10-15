import { buildToolNameMapping } from './shared.js'
import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import type { ProviderContinuation } from '@reflexion-os-studio/contracts'
import type { StreamChatOptions } from './types.js'
import { ProviderError } from './provider-error.js'

export function continuationMatches(
  continuation: ProviderContinuation | undefined,
  options: StreamChatOptions,
): boolean {
  return (
    continuation !== undefined &&
    continuation.baseUrl.replace(/\/$/, '') ===
      options.baseUrl.replace(/\/$/, '') &&
    continuation.model === options.model
  )
}

/** 历史 Store 的 canonical id 与原始供应商 id 按完整轮次位置配对。 */
export function bindReplayCalls(
  message: Extract<ModelMessage, { role: 'assistant' }>,
  providerIds: string[],
  aliases: Map<string, string>,
): void {
  if (providerIds.length !== message.toolCalls.length) {
    throw new ProviderError(
      'provider_protocol',
      'native continuation tool calls do not match canonical history',
    )
  }
  message.toolCalls.forEach((call, index) =>
    aliases.set(call.id, providerIds[index]),
  )
}

/** Signed replay remains unchanged; reserve its tool names before mapping current tools. */
export function buildContinuationToolMapping(
  options: StreamChatOptions,
  apiFormat: 'anthropic' | 'openai-responses',
) {
  const aliases = new Map<string, string>()
  for (const message of options.messages) {
    if (message.role !== 'assistant') continue
    const replay = message.providerContinuation
    if (
      replay?.apiFormat !== apiFormat ||
      !continuationMatches(replay, options)
    )
      continue
    const names =
      replay.apiFormat === 'anthropic'
        ? replay.blocks
            .filter((block) => block.type === 'tool_use')
            .map((block) => block.name)
        : replay.items
            .filter((item) => item.type === 'function_call')
            .map((item) => item.name)
    if (names.length !== message.toolCalls.length)
      throw new ProviderError(
        'provider_protocol',
        'native continuation tool calls do not match canonical history',
      )
    message.toolCalls.forEach((call, index) => {
      const previous = aliases.get(call.name)
      if (previous !== undefined && previous !== names[index])
        throw new ProviderError(
          'provider_protocol',
          'native tool alias changed in history',
        )
      aliases.set(call.name, names[index])
    })
  }
  return buildToolNameMapping(
    (options.tools ?? []).map((tool) => tool.name),
    options.messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.toolCalls.map((call) => call.name)
        : [],
    ),
    aliases,
  )
}
