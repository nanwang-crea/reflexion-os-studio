import { ChatStreamDiagnostics } from './diagnostics.js'
import { providerStreamError } from '../provider-error.js'
import { StreamCallbackError } from '../shared.js'
import { reportToolProgress, reportToolReady } from '../tool-progress.js'
import type { StreamChatOptions, StreamedToolCall } from '../types.js'

/** Aggregate one physical stream; no incomplete tool call can execute here. */
export function createChatStream(
  options: StreamChatOptions,
  providerToCanonical: ReadonlyMap<string, string>,
  onDelta: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
) {
  let content = ''
  let reasoning = ''
  let usage:
    | {
        promptTokens: number
        completionTokens: number
        cachedPromptTokens?: number
      }
    | undefined
  const toolCallByIndex = new Map<number, StreamedToolCall>()
  const diagnostics = new ChatStreamDiagnostics(options)

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      if (trimmed.startsWith(':')) diagnostics.counts.commentLines += 1
      else if (trimmed !== '') diagnostics.counts.otherLines += 1
      return
    }
    diagnostics.counts.dataEvents += 1
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') {
      diagnostics.counts.doneEvents += 1
      return
    }
    let parsed: {
      error?: { message?: unknown; code?: unknown } | string
      choices?: {
        index?: number
        delta?: {
          content?: string
          reasoning_content?: string
          reasoning?: string
          tool_calls?: {
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }[]
        }
        finish_reason?: unknown
      }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
      }
    }
    if (payload === '') {
      diagnostics.counts.emptyDataEvents += 1
      return
    }
    try {
      parsed = JSON.parse(payload)
      diagnostics.counts.jsonEvents += 1
    } catch {
      diagnostics.counts.malformedEvents += 1
      throw new Error('malformed SSE data payload')
    }
    if (parsed.error) {
      diagnostics.counts.providerErrorEvents += 1
      throw providerStreamError(parsed.error, options)
    }
    for (const choice of parsed.choices ?? []) diagnostics.observeChoice(choice)
    diagnostics.observeFinish(parsed.choices?.[0])
    const delta = parsed.choices?.[0]?.delta
    const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning
    if (reasoningDelta) {
      reasoning += reasoningDelta
      diagnostics.counts.reasoningChars += reasoningDelta.length
      try {
        onReasoningDelta?.(reasoningDelta)
      } catch (error) {
        throw new StreamCallbackError(error)
      }
    }
    if (delta?.content) {
      content += delta.content
      diagnostics.counts.contentChars += delta.content.length
      try {
        onDelta(delta.content)
      } catch (error) {
        throw new StreamCallbackError(error)
      }
    }
    for (const chunk of delta?.tool_calls ?? []) {
      diagnostics.counts.toolCallChunks += 1
      const index = typeof chunk.index === 'number' ? chunk.index : 0
      const existing = toolCallByIndex.get(index) ?? {
        id: '',
        name: '',
        arguments: '',
      }
      if (typeof chunk.id === 'string' && chunk.id !== '')
        existing.id = chunk.id
      if (typeof chunk.function?.name === 'string') {
        existing.name += chunk.function.name
      }
      if (typeof chunk.function?.arguments === 'string') {
        existing.arguments += chunk.function.arguments
        diagnostics.counts.toolArgumentChars += chunk.function.arguments.length
      }
      toolCallByIndex.set(index, existing)
      if (existing.name)
        reportToolProgress(options, {
          ...existing,
          id: existing.id || `index-${index}`,
          name: providerToCanonical.get(existing.name) ?? existing.name,
        })
    }
    // Chat Completions has no per-call close event; wait for tool_calls finish.
    if (parsed.choices?.[0]?.finish_reason === 'tool_calls') {
      for (const call of toolCallByIndex.values()) {
        const name = providerToCanonical.get(call.name)
        if (name) reportToolReady(options, { ...call, name })
      }
    }
    if (
      parsed.usage &&
      typeof parsed.usage.prompt_tokens === 'number' &&
      typeof parsed.usage.completion_tokens === 'number'
    ) {
      diagnostics.counts.usageEvents += 1
      const cachedTokens =
        parsed.usage.prompt_cache_hit_tokens ??
        parsed.usage.prompt_tokens_details?.cached_tokens
      usage = {
        promptTokens: parsed.usage.prompt_tokens,
        completionTokens: parsed.usage.completion_tokens,
        ...(typeof cachedTokens === 'number'
          ? { cachedPromptTokens: cachedTokens }
          : {}),
      }
    }
  }

  return {
    diagnostics,
    handleLine,
    toolCallByIndex,
    get content() {
      return content
    },
    get reasoning() {
      return reasoning
    },
    get usage() {
      return usage
    },
  }
}
