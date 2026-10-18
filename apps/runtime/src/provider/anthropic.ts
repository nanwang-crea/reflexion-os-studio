import { describeTransportFailure } from './transport-error.js'
import { reportToolProgress } from './tool-progress.js'
import { ProviderRequestTimeout } from './request-timeout.js'
import { streamReaderCleanup } from './stream-reader.js'
import { buildContinuationToolMapping } from './continuation.js'
import { resolveOutputBudget } from './output-budget.js'
import { anthropicStopReason } from './stop-reasons.js'
import { toAnthropicMessages } from './anthropic/projection.js'
import { AnthropicContinuation } from './anthropic/continuation.js'
import {
  DEFAULT_MAX_RETRIES,
  StreamCallbackError,
  isAbort,
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

  const { canonicalToProvider, providerToCanonical } =
    buildContinuationToolMapping(options, 'anthropic')

  const { system, messages } = toAnthropicMessages(options, canonicalToProvider)

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
        const tools =
          options.tools && options.tools.length > 0
            ? options.tools.map((tool) => ({
                name: canonicalToProvider.get(tool.name) ?? tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              }))
            : undefined
        response = await (options.attemptTracker?.fetch ?? fetch)(
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
    let receivedData = false
    const reader = response.body.getReader()
    const cleanupReader = streamReaderCleanup(reader)
    const decoder = new TextDecoder()
    let buffer = ''
    let sawStop = false

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
        const call = toolCallById.get(currentToolId)
        if (
          block?.type === 'tool_use' &&
          call &&
          providerToCanonical.has(call.name)
        )
          reportToolProgress(options, {
            ...call,
            name: providerToCanonical.get(call.name)!,
          })
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
          if (providerToCanonical.has(existing.name))
            reportToolProgress(options, {
              ...existing,
              name: providerToCanonical.get(existing.name)!,
            })
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
        sawStop = true
        return
      }

      if (eventType === 'error') {
        throw providerStreamError(parsed.error, options)
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
        if (sawStop) break
      }
      handleLine(buffer)
      if (finishReason === null) {
        // 流已结束但从未收到合法 stop_reason（未知 stop_reason 在解析处已即时
        // 失败）：多见于网关提前收尾的瞬时截断，按可重试的流失败处理，复用
        // 传输层重试预算。附带诊断便于定位方言差异。
        throw new ProviderError(
          'provider_protocol',
          `stream ended without a valid stop_reason (raw: ${rawStopReason ?? 'null'}, stopEvent: ${sawStop}, receivedData: ${receivedData}, contentChars: ${content.length}, toolCalls: ${toolCallById.size})`,
          true,
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
