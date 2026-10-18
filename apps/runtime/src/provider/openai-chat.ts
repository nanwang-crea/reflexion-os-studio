import { describeTransportFailure } from './transport-error.js'
import { reportToolProgress } from './tool-progress.js'
import { ProviderRequestTimeout } from './request-timeout.js'
import { streamReaderCleanup } from './stream-reader.js'
import { chatRequestBody } from './openai-chat/projection.js'
import {
  DEFAULT_MAX_RETRIES,
  StreamCallbackError,
  buildToolNameMapping,
  isAbort,
  mapFinishReason,
  mapHttpStatus,
  parseRetryAfterMs,
  retryWaitMs,
  shouldRetryStatus,
  sleep,
} from './shared.js'
import {
  ProviderError,
  redactProviderError,
  providerStreamError,
} from './provider-error.js'
import type {
  StreamChatOptions,
  StreamChatResult,
  StreamedToolCall,
} from './types.js'

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
    /** 服务端 Retry-After 指示的等待毫秒数；缺省时用指数退避。 */
    retryAfterMs?: number | null
  }): Promise<void> => {
    const waitMs = retryWaitMs(
      input.attempt,
      input.retryAfterMs ?? null,
      options,
    )
    options.onRetry?.({
      attempt: input.attempt,
      maxRetries: input.maxRetries,
      reason: input.reason,
      waitMs,
    })
    await sleep(waitMs, options.signal)
  }

  const canonicalToolNames = (options.tools ?? []).map((tool) => tool.name)
  const messageToolNames = options.messages.flatMap((msg) =>
    msg.role === 'assistant' ? msg.toolCalls.map((c) => c.name) : [],
  )
  const { canonicalToProvider, providerToCanonical } = buildToolNameMapping(
    canonicalToolNames,
    messageToolNames,
  )

  let attempt = 0
  let requestTimeout!: ProviderRequestTimeout
  const describeFailure = (
    error: unknown,
    phase: 'request' | 'stream',
    receivedData = false,
  ) =>
    describeTransportFailure(error, {
      phase,
      receivedData,
      retries: attempt,
      maxRetries,
      timeoutMs: options.timeoutMs,
      signal: requestTimeout.signal,
      apiKey: options.apiKey,
    })
  attempts: for (;;) {
    let response: Response
    for (;;) {
      requestTimeout = new ProviderRequestTimeout(
        options.signal,
        options.timeoutMs,
      )
      try {
        response = await (options.attemptTracker?.fetch ?? fetch)(
          `${options.baseUrl.replace(/\/$/, '')}/chat/completions`,
          {
            method: 'POST',
            headers: {
              ...Object.fromEntries(
                (options.headers ?? []).map(({ name, value }) => [name, value]),
              ),
              'content-type': 'application/json',
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify(chatRequestBody(options, canonicalToProvider)),
            signal: requestTimeout.signal,
          },
        )
      } catch (error) {
        requestTimeout.dispose()
        if (error instanceof StreamCallbackError) throw error
        if (options.signal.aborted) throw error
        const failure = describeFailure(error, 'request')
        options.attemptTracker?.finish(
          'failed',
          new ProviderError(failure.code, failure.message),
        )
        if (isAbort(error) && failure.code !== 'timeout') throw error
        if (failure.retryable && attempt < maxRetries) {
          attempt += 1
          await backoffAfterRetry({
            attempt,
            maxRetries,
            reason: failure.reason,
          })
          continue
        }
        throw new ProviderError(failure.code, failure.message)
      }

      if (response.ok) {
        requestTimeout.refresh()
        break
      }
      const detail = await response.text().catch(() => '')
      requestTimeout.dispose()
      options.attemptTracker?.finish(
        'failed',
        new ProviderError(
          mapHttpStatus(response.status),
          `provider responded ${response.status}${detail ? `: ${redactProviderError(detail, options.apiKey, options.headers).slice(0, 200)}` : ''}`,
        ),
      )
      if (shouldRetryStatus(response.status, detail) && attempt < maxRetries) {
        attempt += 1
        await backoffAfterRetry({
          attempt,
          maxRetries,
          reason: `HTTP ${response.status}`,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        })
        continue
      }
      throw new ProviderError(
        mapHttpStatus(response.status),
        `provider responded ${response.status}${detail ? `: ${redactProviderError(detail, options.apiKey, options.headers).slice(0, 200)}` : ''}`,
      )
    }
    if (!response.body) {
      requestTimeout.dispose()
      const error = new Error('provider response has no body')
      const failure = describeFailure(error, 'stream')
      options.attemptTracker?.finish(
        'failed',
        new ProviderError(failure.code, failure.message),
      )
      if (attempt < maxRetries) {
        attempt += 1
        await backoffAfterRetry({
          attempt,
          maxRetries,
          reason: failure.reason,
        })
        continue
      }
      throw new ProviderError(failure.code, failure.message)
    }

    let content = ''
    let reasoning = ''
    let finishReason:
      'stop' | 'length' | 'content_filter' | 'tool_calls' | null = null
    let rawFinishReason: string | null | undefined
    let usage:
      | {
          promptTokens: number
          completionTokens: number
          cachedPromptTokens?: number
        }
      | undefined
    const toolCallByIndex = new Map<number, StreamedToolCall>()
    let receivedData = false
    const reader = response.body.getReader()
    const cleanupReader = streamReaderCleanup(reader)
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
        error?: { message?: unknown; code?: unknown } | string
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
      if (parsed.error) {
        throw providerStreamError(parsed.error, options)
      }
      const delta = parsed.choices?.[0]?.delta
      const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning
      if (reasoningDelta) {
        reasoning += reasoningDelta
        try {
          onReasoningDelta?.(reasoningDelta)
        } catch (error) {
          cleanupReader()
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
        if (providerToCanonical.has(existing.name))
          reportToolProgress(options, {
            ...existing,
            id: existing.id || `index-${index}`,
            name: providerToCanonical.get(existing.name)!,
          })
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
        receivedData ||= value.byteLength > 0
        options.attemptTracker?.received(value.byteLength)
        requestTimeout.refresh()
        buffer += decoder.decode(value, { stream: true })
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex !== -1) {
          handleLine(buffer.slice(0, newlineIndex))
          buffer = buffer.slice(newlineIndex + 1)
          newlineIndex = buffer.indexOf('\n')
        }
        if (sawDone) break
      }
      handleLine(buffer)
      if (!sawDone) {
        throw new Error('stream ended before [DONE]')
      }
      if (finishReason === null) {
        // [DONE] 已到但从未出现合法 finish_reason：多见于网关提前收尾的瞬时
        // 截断，按可重试的流失败处理（复用传输层重试预算）；出现过未知非空
        // 值属于方言不匹配，重试无意义，立即失败。附带诊断便于定位方言差异。
        const missing =
          rawFinishReason === undefined || rawFinishReason === null
        const raw = redactProviderError(
          rawFinishReason,
          options.apiKey,
          options.headers,
        ).slice(0, 40)
        throw new ProviderError(
          'provider_protocol',
          `stream ended without a valid finish_reason (raw: ${raw}, done: ${sawDone}, receivedData: ${receivedData}, contentChars: ${content.length}, toolCalls: ${toolCallByIndex.size})`,
          missing,
        )
      }
    } catch (error) {
      requestTimeout.dispose()
      cleanupReader()
      if (options.signal.aborted) throw error
      if (error instanceof StreamCallbackError) throw error.cause
      const failure =
        error instanceof ProviderError
          ? {
              code: error.code,
              message: error.message,
              reason: error.message,
              retryable: error.retryable,
            }
          : describeFailure(error, 'stream', receivedData)
      options.attemptTracker?.finish(
        'failed',
        new ProviderError(failure.code, failure.message),
      )
      if (isAbort(error) && failure.code !== 'timeout') throw error
      if (failure.retryable && attempt < maxRetries) {
        attempt += 1
        await backoffAfterRetry({
          attempt,
          maxRetries,
          reason: failure.reason,
        })
        continue attempts
      }
      throw new ProviderError(failure.code, failure.message)
    } finally {
      requestTimeout.dispose()
      cleanupReader()
    }

    // 空/重复 id 会让 Run 层按 call.id 建索引时互相覆盖；兜底为轮次内唯一 id。
    const seenIds = new Set<string>()
    const toolCalls = [...toolCallByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, toolCall]) => {
        const base = toolCall.id !== '' ? toolCall.id : `index-${index}`
        let id = base
        let suffix = 2
        while (seenIds.has(id)) {
          id = `${base}_${suffix}`
          suffix += 1
        }
        seenIds.add(id)
        return {
          ...toolCall,
          id,
          name: providerToCanonical.get(toolCall.name) ?? toolCall.name,
        }
      })

    return {
      content,
      reasoning,
      finishReason,
      rawStopReason: finishReason,
      usage,
      toolCalls,
    }
  }
}
