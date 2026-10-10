import { ProviderError } from '../provider-error.js'
import type { StreamedToolCall } from '../types.js'

/** 参数流按 output item 关联；call_id 只用于最终模型/工具协议配对。 */
export class ResponsesToolCalls {
  private readonly calls = new Map<string, StreamedToolCall>()
  private readonly itemToCall = new Map<string, string>()
  private readonly callToItem = new Map<string, string>()

  handle(event: Record<string, unknown>): boolean {
    const type = event.type
    if (
      type === 'response.output_item.added' ||
      type === 'response.output_item.done'
    ) {
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type !== 'function_call') return true
      const callId = String(item.call_id ?? '')
      const itemId = String(item.id ?? '')
      if (!callId)
        throw new ProviderError(
          'provider_protocol',
          'function call has no call_id',
        )
      if (itemId) {
        const previous = this.itemToCall.get(itemId)
        if (previous && previous !== callId) {
          throw new ProviderError(
            'provider_protocol',
            'function call item changed call_id',
          )
        }
        const previousItem = this.callToItem.get(callId)
        if (previousItem && previousItem !== itemId) {
          throw new ProviderError(
            'provider_protocol',
            'function call_id belongs to multiple items',
          )
        }
        this.itemToCall.set(itemId, callId)
        this.callToItem.set(callId, itemId)
      }
      const call = this.calls.get(callId) ?? {
        id: callId,
        name: '',
        arguments: '',
      }
      call.name = String(item.name ?? call.name)
      if (
        typeof item.arguments === 'string' &&
        (type === 'response.output_item.done' || !this.calls.has(callId))
      ) {
        call.arguments = item.arguments
      }
      this.calls.set(callId, call)
      return true
    }
    if (
      type !== 'response.function_call_arguments.delta' &&
      type !== 'response.function_call_arguments.done'
    )
      return false
    const itemId = String(event.item_id ?? '')
    const callId = itemId
      ? this.itemToCall.get(itemId)
      : typeof event.call_id === 'string'
        ? event.call_id
        : undefined
    if (!callId)
      throw new ProviderError(
        'provider_protocol',
        'function arguments reference an unknown item',
      )
    const call = this.calls.get(callId) ?? {
      id: callId,
      name: '',
      arguments: '',
    }
    if (type === 'response.function_call_arguments.done') {
      call.arguments = String(event.arguments ?? '')
    } else {
      call.arguments += String(event.delta ?? '')
    }
    this.calls.set(callId, call)
    return true
  }

  values(): StreamedToolCall[] {
    return [...this.calls.values()]
  }
}
