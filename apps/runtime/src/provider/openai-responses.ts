import { describeTransportFailure } from './transport-error.js'
import { reportToolProgress } from './tool-progress.js'
import { ProviderRequestTimeout } from './request-timeout.js'
import { streamReaderCleanup } from './stream-reader.js'
import { buildContinuationToolMapping } from './continuation.js'
import { ResponsesToolCalls } from './openai-responses/tool-calls.js'
import { responsesStopReason } from './stop-reasons.js'
import { toResponsesInput } from './openai-responses/projection.js'
import { ResponsesContinuation } from './openai-responses/continuation.js'
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

export async function streamOpenAIResponses(
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
    buildContinuationToolMapping(options, 'openai-responses')

  const { instructions, input } = toResponsesInput(options, canonicalToProvider)

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
                type: 'function' as const,
                name: canonicalToProvider.get(tool.name) ?? tool.name,
                description: tool.description,
                parameters: tool.parameters,
              }))
            : undefined
        response = await (options.attemptTracker?.fetch ?? fetch)(
          `${options.baseUrl.replace(/\/$/, '')}/v1/responses`,
          {
            method: 'POST',
            headers: {
              ...Object.fromEntries(
                (options.headers ?? []).map(({ name, value }) => [name, value]),
              ),
              'content-type': 'application/json',
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
              model: options.model,
              input,
              stream: true,
              include: ['reasoning.encrypted_content'],
              ...(options.reasoningEffort !== undefined
                ? { reasoning: { effort: options.reasoningEffort } }
                : {}),
              ...(instructions !== undefined ? { instructions } : {}),
              ...(options.maxTokens !== undefined
                ? { max_output_tokens: options.maxTokens }
                : {}),
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

    const continuation = new ResponsesContinuation()
    let content = ''
    let reasoning = ''
    let finishReason: StreamChatResult['finishReason'] | null = null
    let rawStopReason: string | undefined
    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens: number | undefined
    const toolCalls: StreamedToolCall[] = []
    const streamedCalls = new ResponsesToolCalls()
    let receivedData = false
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

      if (eventType === 'response.output_text.delta') {
        const delta = String(parsed.delta ?? '')
        content += delta
        try {
          onDelta(delta)
        } catch (error) {
          cleanupReader()
          throw new StreamCallbackError(error)
        }
        return
      }

      if (eventType === 'response.reasoning_summary_text.delta') {
        const delta = String(parsed.delta ?? '')
        reasoning += delta
        try {
          onReasoningDelta?.(delta)
        } catch (error) {
          throw new StreamCallbackError(error)
        }
        return
      }

      if (streamedCalls.handle(parsed)) {
        for (const call of streamedCalls.values()) {
          if (providerToCanonical.has(call.name))
            reportToolProgress(options, {
              ...call,
              name: providerToCanonical.get(call.name)!,
            })
        }
        return
      }

      if (eventType === 'response.failed') {
        // 终态失败事件：把服务端给出的错误码与原因透出，避免只剩
        // "stream ended without a completion status" 这类无诊断价值的报错。
        const item = (parsed.response ?? parsed.item) as
          Record<string, unknown> | undefined
        const error = item?.error as Record<string, unknown> | undefined
        throw providerStreamError(error, options)
      }

      if (
        eventType === 'response.completed' ||
        eventType === 'response.incomplete'
      ) {
        const item = (parsed.response ?? parsed.item) as
          Record<string, unknown> | undefined
        if (item) {
          if (Array.isArray(item.output)) {
            for (const output of item.output) {
              streamedCalls.handle({
                type: 'response.output_item.done',
                item: output,
              })
            }
          }
          const terminal = responsesStopReason(item)
          finishReason = terminal.finishReason
          rawStopReason = terminal.rawStopReason
          const usage = item.usage as Record<string, unknown> | undefined
          if (typeof usage?.input_tokens === 'number')
            inputTokens = usage.input_tokens
          if (typeof usage?.output_tokens === 'number')
            outputTokens = usage.output_tokens
          if (
            typeof usage?.input_tokens_details === 'object' &&
            usage.input_tokens_details !== null
          ) {
            const details = usage.input_tokens_details as Record<
              string,
              unknown
            >
            if (typeof details.cached_tokens === 'number')
              cachedTokens = details.cached_tokens
          }
        }
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
        if (finishReason !== null) break
      }
      handleLine(buffer)
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

    // 按原生 output 顺序回填调用，保证重启后仍可按位置配对原始 id。
    const providerContinuation = continuation.result(options)
    const calls =
      providerContinuation?.apiFormat === 'openai-responses'
        ? providerContinuation.items
            .filter((item) => item.type === 'function_call')
            .map((item) => ({
              id: item.call_id,
              name: item.name,
              arguments: item.arguments,
            }))
        : streamedCalls.values()
    for (const toolCall of calls) {
      toolCalls.push({
        ...toolCall,
        name: providerToCanonical.get(toolCall.name) ?? toolCall.name,
      })
    }

    if (finishReason === 'stop' && toolCalls.length > 0)
      finishReason = 'tool_calls'
    if (finishReason === null) {
      throw new ProviderError(
        'provider_protocol',
        'stream ended without a completion status',
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
