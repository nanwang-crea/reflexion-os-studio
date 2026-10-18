import { describeTransportFailure } from './transport-error.js'
import { ProviderRequestTimeout } from './request-timeout.js'
import { streamReaderCleanup } from './stream-reader.js'
import { chatRequestBody } from './openai-chat/projection.js'
import { createChatStream } from './openai-chat/stream.js'
import {
  DEFAULT_MAX_RETRIES,
  StreamCallbackError,
  buildToolNameMapping,
  isAbort,
  mapHttpStatus,
  parseRetryAfterMs,
  retryWaitMs,
  shouldRetryStatus,
  sleep,
} from './shared.js'
import { ProviderError, redactProviderError } from './provider-error.js'
import type { StreamChatOptions, StreamChatResult } from './types.js'

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

    const stream = createChatStream(
      options,
      providerToCanonical,
      onDelta,
      onReasoningDelta,
    )
    const { diagnostics, handleLine, toolCallByIndex } = stream
    const requestAttemptId = options.attemptTracker?.id
    let receivedData = false
    const reader = response.body.getReader()
    const cleanupReader = streamReaderCleanup(reader)
    const decoder = new TextDecoder()
    let buffer = ''

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
        if (diagnostics.counts.doneEvents > 0) break
      }
      handleLine(buffer)
      // 未知值优先于缺失结束标记，避免 EOF 或 usage 块掩盖协议错误。
      const terminalError = diagnostics.terminalError()
      if (diagnostics.counts.unsupportedFinishFields > 0) throw terminalError
      if (diagnostics.counts.doneEvents === 0) {
        throw new Error('stream ended before [DONE]')
      }
      if (terminalError) throw terminalError
    } catch (error) {
      requestTimeout.dispose()
      cleanupReader()
      if (options.signal.aborted) throw error
      if (error instanceof StreamCallbackError) throw error.cause
      const terminalError =
        diagnostics.counts.unsupportedFinishFields > 0
          ? diagnostics.terminalError()
          : null
      const failureError = terminalError ?? error
      const baseFailure =
        failureError instanceof ProviderError
          ? {
              code: failureError.code,
              message: failureError.message,
              reason: failureError.message,
              retryable: failureError.retryable,
            }
          : describeFailure(failureError, 'stream', receivedData)
      const details = diagnostics.describe(receivedData, toolCallByIndex.size)
      const failure = {
        ...baseFailure,
        message: `${baseFailure.message}; ${details}`,
        reason: `${baseFailure.reason}; ${details}`,
      }
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
      process.stderr.write(
        `${JSON.stringify({
          type: 'provider.chat_stream',
          requestAttemptId,
          ...diagnostics.snapshot(),
        })}\n`,
      )
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
      content: stream.content,
      reasoning: stream.reasoning,
      finishReason: diagnostics.finishReason!,
      rawStopReason: diagnostics.finishReason!,
      usage: stream.usage,
      toolCalls,
    }
  }
}
