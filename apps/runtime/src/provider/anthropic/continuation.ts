import {
  AnthropicReplayBlockSchema,
  type AnthropicReplayBlock,
  type ProviderContinuation,
} from '@reflexion-os-studio/contracts'
import { ProviderError } from '../provider-error.js'
import type { StreamChatOptions } from '../types.js'

/** 按 block index 聚合签名与正文；redacted_thinking 块保持原样，签名从不用于 UI。 */
export class AnthropicContinuation {
  private readonly blocks = new Map<number, Record<string, unknown>>()
  private readonly complete = new Set<number>()

  handle(event: Record<string, unknown>): void {
    const index = Number(event.index ?? 0)
    if (event.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block) this.blocks.set(index, { ...block })
    } else if (event.type === 'content_block_delta') {
      const block = this.blocks.get(index)
      const delta = event.delta as Record<string, unknown> | undefined
      if (!block || !delta) return
      if (delta.type === 'thinking_delta')
        block.thinking =
          String(block.thinking ?? '') + String(delta.thinking ?? '')
      if (delta.type === 'signature_delta')
        block.signature =
          String(block.signature ?? '') + String(delta.signature ?? '')
      if (delta.type === 'text_delta')
        block.text = String(block.text ?? '') + String(delta.text ?? '')
      if (delta.type === 'input_json_delta')
        block.partialJson =
          String(block.partialJson ?? '') + String(delta.partial_json ?? '')
    } else if (event.type === 'content_block_stop') {
      const block = this.blocks.get(index)
      if (block?.type === 'tool_use' && typeof block.partialJson === 'string') {
        try {
          block.input = JSON.parse(block.partialJson)
        } catch {
          throw new ProviderError(
            'provider_protocol',
            'invalid native tool input',
          )
        }
        delete block.partialJson
      }
      this.complete.add(index)
    }
  }

  result(options: StreamChatOptions): ProviderContinuation | undefined {
    if (
      ![...this.blocks.values()].some(
        (block) =>
          block.type === 'thinking' || block.type === 'redacted_thinking',
      )
    )
      return undefined
    const blocks: AnthropicReplayBlock[] = []
    for (const [index, block] of [...this.blocks].sort(([a], [b]) => a - b)) {
      const parsed = AnthropicReplayBlockSchema.safeParse(block)
      if (!this.complete.has(index) || !parsed.success) {
        throw new ProviderError(
          'provider_protocol',
          'incomplete native thinking continuation',
        )
      }
      blocks.push(parsed.data)
    }
    return {
      apiFormat: 'anthropic',
      baseUrl: options.baseUrl,
      model: options.model,
      blocks,
    }
  }
}
