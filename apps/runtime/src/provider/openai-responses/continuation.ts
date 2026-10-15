import {
  ResponsesReplayItemSchema,
  type ProviderContinuation,
} from '@reflexion-os-studio/contracts'
import { ProviderError } from '../provider-error.js'
import type { StreamChatOptions } from '../types.js'

/** 完整 output item 优先于 delta；终态 output 可补全/覆盖已完成的逐项事件。 */
export class ResponsesContinuation {
  private readonly items = new Map<number, unknown>()
  private terminalOutput: unknown[] | undefined
  private sawReasoning = false

  handle(event: Record<string, unknown>): void {
    if (event.type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type === 'reasoning') this.sawReasoning = true
    }
    if (event.type === 'response.output_item.done') {
      this.items.set(Number(event.output_index ?? this.items.size), event.item)
    }
    if (
      event.type === 'response.completed' ||
      event.type === 'response.incomplete'
    ) {
      const response = event.response as Record<string, unknown> | undefined
      if (Array.isArray(response?.output)) this.terminalOutput = response.output
    }
  }

  result(options: StreamChatOptions): ProviderContinuation | undefined {
    const items =
      this.terminalOutput ??
      [...this.items].sort(([a], [b]) => a - b).map(([, item]) => item)
    if (
      !items.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          item.type === 'reasoning',
      )
    ) {
      if (this.sawReasoning)
        throw new ProviderError(
          'provider_protocol',
          'missing completed native reasoning item',
        )
      return undefined
    }
    const parsed = ResponsesReplayItemSchema.array().safeParse(items)
    if (!parsed.success)
      throw new ProviderError(
        'provider_protocol',
        'invalid native reasoning continuation',
      )
    return {
      apiFormat: 'openai-responses',
      baseUrl: options.baseUrl,
      model: options.model,
      items: parsed.data,
    }
  }
}
