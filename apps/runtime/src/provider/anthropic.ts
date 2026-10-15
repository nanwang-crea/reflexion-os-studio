import { streamReaderCleanup } from './stream-reader.js'
import { buildContinuationToolMapping } from './continuation.js'
import { resolveOutputBudget } from './output-budget.js'
import { anthropicStopReason } from './stop-reasons.js'
import { toAnthropicMessages } from './anthropic/projection.js'
import { AnthropicContinuation } from './anthropic/continuation.js'
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  StreamCallbackError,
  isAbort,
  isTimeout,
  mapHttpStatus,
  retryBackoffMs,
  shouldRetryStatus,
  sleep,
} from './shared.js'
import { ProviderError, redactProviderError } from './provider-error.js'
import type {
  StreamChatOptions,
  StreamChatResult,
  StreamedToolCall,
} from './types.js'

export async function streamAnthropic(
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
    const waitMs = retryBackoffMs(input.attempt)
    options.onRetry?.({ ...input, waitMs })
    await sleep(waitMs, options.signal)
  }

  const { canonicalToProvider, providerToCanonical } =
    buildContinuationToolMapping(options, 'anthropic')

  const { system, messages } = toAnthropicMessages(options, canonicalToProvider)

  let attempt = 0
  attempts: for (;;) {
    let response: Response
    for (;;) {
      const attemptTimeout = AbortSignal.timeout(
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      const attemptSignal = AbortSignal.any([options.signal, attemptTimeout])
      try {
        const tools =
          options.tools && options.tools.length > 0
            ? options.tools.map((tool) => ({
                name: canonicalToProvider.get(tool.name) ?? tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              }))
            : undefined
        response = await fetch(
          `${options.baseUrl.replace(/\/$/, '')}/v1/messages`,
          {
            method: 'POST',
            headers: {
              ...Object.fromEntries(
                (options.headers ?? []).map(({ name, value }) => [name, value]),
              ),
              'content-type': 'application/json',
              'x-api-key': options.apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: options.model,
              messages,
              max_tokens: resolveOutputBudget({
                ...options,
                apiFormat: 'anthropic',
              }).requestMaxTokens,
              stream: true,
              ...(system !== undefined ? { system } : {}),
              ...(options.temperature !== undefined
                ? { temperature: options.temperature }
                : {}),
              ...(tools !== undefined ? { tools } : {}),
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
            reason: `${isTimeout(error) ? 'timeout' : 'network'}: ${redactProviderError(error, options.apiKey)}`,
          })
          continue
        }
        throw new ProviderError(
          isTimeout(error) ? 'timeout' : 'network',
          `provider request failed: ${redactProviderError(error, options.apiKey)}`,
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
        `provider responded ${response.status}${detail ? `: ${redactProviderError(detail, options.apiKey).slice(0, 200)}` : ''}`,
      )
    }
    if (!response.body) {
      const error = new Error('provider response has no body')
      if (attempt < maxRetries) {
        attempt += 1
        await backoffAfterRetry({
          attempt,
          maxRetries,
          reason: `stream failure: ${redactProviderError(error, options.apiKey)}`,
        })
        continue
      }
      throw new ProviderError(
        'network',
        `provider stream failed: ${redactProviderError(error, options.apiKey)}`,
      )
    }

    const continuation = new AnthropicContinuation()
    let content = ''
    let reasoning = ''
    let finishReason: StreamChatResult['finishReason'] | null = null
    let rawStopReason: string | undefined
    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens: number | undefined
    const toolCalls: StreamedToolCall[] = []
    const toolCallById = new Map<
      string,
      { id: string; name: string; arguments: string }
    >()
    let currentToolId = ''
    let currentToolName = ''
    const reader = response.body.getReader()
    const cleanupReader = streamReaderCleanup(reader)
    const decoder = new TextDecoder()
    let buffer = ''

    const handleLine = (line: string): void => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) return
      const payload = trimmed.slice(5).trim()
      if (payload === '') return
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(payload)
      } catch {
        throw new Error('malformed SSE data payload')
      }
      const eventType = parsed.type as string | undefined
      continuation.handle(parsed)

      if (eventType === 'message_start') {
        const msg = parsed.message as Record<string, unknown> | undefined
        const usage = msg?.usage as Record<string, unknown> | undefined
        if (typeof usage?.input_tokens === 'number')
          inputTokens = usage.input_tokens
        if (typeof usage?.cache_read_input_tokens === 'number')
          cachedTokens = usage.cache_read_input_tokens
        return
      }

      if (eventType === 'content_block_start') {
        const block = parsed.content_block as
          Record<string, unknown> | undefined
        if (block?.type === 'tool_use') {
          currentToolId = String(block.id ?? '')
          currentToolName = String(block.name ?? '')
          toolCallById.set(currentToolId, {
            id: currentToolId,
            name: currentToolName,
            arguments:
              block.input && Object.keys(block.input as object).length > 0
                ? JSON.stringify(block.input)
                : '',
          })
        }
        return
      }

      if (eventType === 'content_block_delta') {
        const delta = parsed.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta') {
          const text = String(delta.text ?? '')
          content += text
          try {
            onDelta(text)
          } catch (error) {
            cleanupReader()
            throw new StreamCallbackError(error)
          }
        } else if (delta?.type === 'thinking_delta') {
          const thinking = String(delta.thinking ?? '')
          reasoning += thinking
          try {
            onReasoningDelta?.(thinking)
          } catch (error) {
            throw new StreamCallbackError(error)
          }
        } else if (delta?.type === 'input_json_delta') {
          const existing = toolCallById.get(currentToolId) ?? {
            id: currentToolId,
            name: currentToolName,
            arguments: '',
          }
          existing.arguments += String(delta.partial_json ?? '')
          toolCallById.set(currentToolId, existing)
        }
        return
      }

      if (eventType === 'content_block_stop') {
        return
      }

      if (eventType === 'message_delta') {
        const delta = parsed.delta as Record<string, unknown> | undefined
        if (delta?.stop_reason) {
          rawStopReason = String(delta.stop_reason)
          finishReason = anthropicStopReason(rawStopReason)
        }
        const usage = parsed.usage as Record<string, unknown> | undefined
        if (typeof usage?.output_tokens === 'number')
          outputTokens = usage.output_tokens
        return
      }

      if (eventType === 'message_stop') {
        return
      }

      if (eventType === 'error') {
        const err = parsed.error as Record<string, unknown> | undefined
        throw new ProviderError(
          'provider',
          `anthropic error: ${String(err?.message ?? 'unknown')}`,
        )
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
    } catch (error) {
      if (error instanceof StreamCallbackError) throw error.cause
      if (isAbort(error)) throw error
      if (error instanceof ProviderError) throw error
      if (attempt < maxRetries) {
        attempt += 1
        await backoffAfterRetry({
          attempt,
          maxRetries,
          reason: isTimeout(error)
            ? `timeout: ${redactProviderError(error, options.apiKey)}`
            : `stream failure: ${redactProviderError(error, options.apiKey)}`,
        })
        continue attempts
      }
      throw new ProviderError(
        isTimeout(error) ? 'timeout' : 'network',
        `provider stream failed: ${redactProviderError(error, options.apiKey)}`,
      )
    } finally {
      cleanupReader()
    }

    const providerContinuation = continuation.result(options)
    const calls =
      providerContinuation?.apiFormat === 'anthropic'
        ? providerContinuation.blocks
            .filter((block) => block.type === 'tool_use')
            .map((block) => ({
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input),
            }))
        : [...toolCallById.values()]
    for (const toolCall of calls) {
      toolCalls.push({
        ...toolCall,
        arguments: toolCall.arguments || '{}',
        name: providerToCanonical.get(toolCall.name) ?? toolCall.name,
      })
    }

    if (finishReason === null) {
      throw new ProviderError(
        'provider_protocol',
        'stream ended without a valid stop_reason',
      )
    }

    return {
      content,
      reasoning,
      providerContinuation,
      finishReason,
      rawStopReason,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        ...(typeof cachedTokens === 'number'
          ? { cachedPromptTokens: cachedTokens }
          : {}),
      },
      toolCalls,
    }
  }
}
