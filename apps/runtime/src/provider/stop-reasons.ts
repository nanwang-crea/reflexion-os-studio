import type { ModelFinishReason } from '@reflexion-os-studio/agent-core'
import { ProviderError } from './provider-error.js'

export function anthropicStopReason(reason: string): ModelFinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'model_context_window_exceeded':
      return 'context_limit'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'content_filter'
    default:
      throw new ProviderError(
        'provider_protocol',
        'unsupported Anthropic stop reason',
      )
  }
}

export function responsesStopReason(response: Record<string, unknown>): {
  finishReason: ModelFinishReason
  rawStopReason: string
} {
  if (response.status === 'completed') {
    return { finishReason: 'stop', rawStopReason: 'completed' }
  }
  const details = response.incomplete_details as
    Record<string, unknown> | undefined
  const reason = details?.reason
  if (response.status === 'incomplete' && reason === 'max_output_tokens') {
    return { finishReason: 'length', rawStopReason: reason }
  }
  if (response.status === 'incomplete' && reason === 'content_filter') {
    return { finishReason: 'content_filter', rawStopReason: reason }
  }
  throw new ProviderError(
    'provider_protocol',
    'unsupported Responses terminal status or incomplete reason',
  )
}
