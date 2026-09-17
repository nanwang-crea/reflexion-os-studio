import type { ToolSpec } from '@reflexion-os-studio/contracts'
import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  StreamCallbackError,
  buildToolNameMapping,
  isAbort,
  isTimeout,
  mapFinishReason,
  mapHttpStatus,
  retryBackoffMs,
  shouldRetryStatus,
  sleep,
} from './shared.js'
import { ProviderError } from './provider-error.js'
import type {
  StreamChatOptions,
  StreamChatResult,
  StreamedToolCall,
} from './types.js'

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
    case 'user':
      return { role: message.role, content: message.content }
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

export async function streamOpenAIChat(
  options: StreamChatOptions,
  onDelta: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
): Promise<StreamChatResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES

  const backoffAfterRetry = async (input: {
    attempt: number
    maxRetries: number
    reason: string
  }): Promise<void> => {
    const waitMs = retryBackoffMs(attempt)
    options.onRetry?.({ ...input, waitMs })
    await sleep(waitMs, options.signal)
  }

  const canonicalToolNames = (options.tools ?? []).map((tool) => tool.name)
  const messageToolNames = options.messages.flatMap((msg) =>
    msg.role === 'assistant'
      ? msg.toolCalls.map((c) => c.name)
      : [],
  )
  const { canonicalToProvider, providerToCanonical } = buildToolNameMapping(
    canonicalToolNames,
    messageToolNames,
  )

  let attempt = 0
  attempts: for (;;) {
    let response: Response
    for (;;) {
      const attemptTimeout = AbortSignal.timeout(
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      const attemptSignal = AbortSignal.any([options.signal, attemptTimeout])
      try {
        const tools: ToolSpec[] | undefined =
          options.tools && options.tools.length > 0
            ? options.tools.map((tool) => ({
                name: canonicalToProvider.get(tool.name) ?? tool.name,
                description: tool.description,
                parameters: tool.parameters,
              }))
            : undefined
        response = await fetch(
          `${options.baseUrl.replace(/\/$/, '')}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
              model: options.model,
              messages: options.messages.map((message) =>
                toProviderMessage(message, canonicalToProvider),
              ),
              stream: true,
              stream_options: { include_usage: true },
              ...(options.maxTokens !== undefined
                ? { max_tokens: options.maxTokens }
                : {}),
              ...(options.temperature !== undefined
                ? { temperature: options.temperature }
                : {}),
              ...(tools !== undefined
                ? {
                    tools: tools.map((tool) => ({
                      type: 'function',
                      function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                      },
                    })),
                  }
                : {}),
            }),
            signal: attemptSignal,
          },
        )
      } catch (error) {
        if (options.signal.aborted) throw error
        if (isAbort(error)) throw error
        if (attempt < maxRetries) {
          attempt += 1
          await backoffAfterRetry({
            attempt,
            maxRetries,
            reason: `${isTimeout(error) ? 'timeout' : 'network'}: ${String(error)}`,
          })
          continue
        }
        throw new ProviderError(
          isTimeout(error) ? 'timeout' : 'network',
          `provider request failed: ${String(error)}`,
        )
      }

      if (response.ok) break
      const detail = await response.text().catch(() => '')
      if (shouldRetryStatus(response.status, detail) && attempt < maxRetries) {
        attempt += 1
        await backoffAfterRetry({
          attempt,
          maxRetries,
          reason: `HTTP ${response.status}`,
        })
        continue
      }
      throw new ProviderError(
        mapHttpStatus(response.status),
        `provider responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      )
    }
    if (!response.body) {
      const error = new Error('provider response has no body')
      if (attempt < maxRetries) {
        attempt += 1
        await backoffAfterRetry({
          attempt,
          maxRetries,
          reason: `stream failure: ${String(error)}`,
        })
        continue
      }
      throw new ProviderError(
        'network',
        `provider stream failed: ${String(error)}`,
      )
    }

    let content = ''
    let reasoning = ''
    let finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null =
      null
    let rawFinishReason: string | null | undefined
    let usage:
      | { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }
      | undefined
    const toolCallByIndex = new Map<number, StreamedToolCall>()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawDone = false

    const handleLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') {
        sawDone = true
        return
      }
      let parsed: {
        choices?: {
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
          finish_reason?: string | null
        }[]
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
          prompt_cache_hit_tokens?: number
          prompt_cache_miss_tokens?: number
        }
      }
      if (payload === '') return
      try {
        parsed = JSON.parse(payload)
      } catch {
        throw new Error('malformed SSE data payload')
      }
      const delta = parsed.choices?.[0]?.delta
      const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning
      if (reasoningDelta) {
        reasoning += reasoningDelta
        try {
          onReasoningDelta?.(reasoningDelta)
        } catch (error) {
          throw new StreamCallbackError(error)
        }
      }
      if (delta?.content) {
        content += delta.content
        try {
          onDelta(delta.content)
        } catch (error) {
          throw new StreamCallbackError(error)
        }
      }
      for (const chunk of delta?.tool_calls ?? []) {
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
        }
        toolCallByIndex.set(index, existing)
      }
      rawFinishReason = parsed.choices?.[0]?.finish_reason
      const mapped = mapFinishReason(rawFinishReason)
      if (mapped) finishReason = mapped
      if (parsed.usage) {
        const cachedTokens =
          parsed.usage.prompt_cache_hit_tokens ??
          parsed.usage.prompt_tokens_details?.cached_tokens
        usage = {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          ...(typeof cachedTokens === 'number'
            ? { cachedPromptTokens: cachedTokens }
            : {}),
        }
      }
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex !== -1) {
          handleLine(buffer.slice(0, newlineIndex))
          buffer = buffer.slice(newlineIndex + 1)
          newlineIndex = buffer.indexOf('\n')
        }
      }
      handleLine(buffer)
      if (!sawDone) {
        throw new Error('stream ended before [DONE]')
      }
    } catch (error) {
      if (error instanceof StreamCallbackError) throw error.cause
      if (isAbort(error)) throw error
      if (attempt < maxRetries) {
        attempt += 1
        await backoffAfterRetry({
          attempt,
          maxRetries,
          reason: isTimeout(error)
            ? `timeout: ${String(error)}`
            : `stream failure: ${String(error)}`,
        })
        continue attempts
      }
      throw new ProviderError(
        isTimeout(error) ? 'timeout' : 'network',
        `provider stream failed: ${String(error)}`,
      )
    }

    const toolCalls = [...toolCallByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, toolCall]) => ({
        ...toolCall,
        name: providerToCanonical.get(toolCall.name) ?? toolCall.name,
      }))

    if (finishReason === null) {
      throw new ProviderError(
        'provider_protocol',
        `stream ended without a valid finish_reason (raw: ${String(rawFinishReason).slice(0, 40)})`,
      )
    }

    return { content, reasoning, finishReason, usage, toolCalls }
  }
}
