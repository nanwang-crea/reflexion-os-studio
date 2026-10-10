import { ResponsesToolCalls } from './openai-responses/tool-calls.js'
import { responsesStopReason } from './stop-reasons.js'
import { userImageContent } from './image-content.js'
import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  StreamCallbackError,
  buildToolNameMapping,
  isAbort,
  isTimeout,
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
 * canonical ModelMessage 投影为 OpenAI Responses API input 格式：
 * system 消息提取为 instructions，assistant 的工具调用保留为 function_call，
 * 工具结果走 function_call_output。
 */
function toResponsesInput(
  messages: ModelMessage[],
  canonicalToProvider: ReadonlyMap<string, string>,
): {
  instructions: string | undefined
  input: Array<Record<string, unknown>>
} {
  let instructions: string | undefined
  const input: Array<Record<string, unknown>> = []

  for (const message of messages) {
    if (message.role === 'system') {
      instructions = instructions
        ? `${instructions}\n${message.content}`
        : message.content
      continue
    }
    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: userImageContent(message, 'openai-responses'),
      })
      continue
    }
    if (message.role === 'assistant') {
      if (message.toolCalls.length === 0) {
        input.push({ role: 'assistant', content: message.content })
      } else {
        // 文本部分
        if (message.content) {
          input.push({ role: 'assistant', content: message.content })
        }
        // 工具调用部分
        for (const call of message.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: canonicalToProvider.get(call.name) ?? call.name,
            arguments: call.arguments,
          })
        }
      }
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      })
    }
  }

  return { instructions, input }
}

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
  }): Promise<void> => {
    const waitMs = retryBackoffMs(input.attempt)
    options.onRetry?.({ ...input, waitMs })
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

  const { instructions, input } = toResponsesInput(
    options.messages,
    canonicalToProvider,
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
        const tools =
          options.tools && options.tools.length > 0
            ? options.tools.map((tool) => ({
                type: 'function' as const,
                name: canonicalToProvider.get(tool.name) ?? tool.name,
                description: tool.description,
                parameters: tool.parameters,
              }))
            : undefined
        response = await fetch(
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
              ...(instructions !== undefined ? { instructions } : {}),
              ...(options.maxTokens !== undefined
                ? { max_output_tokens: options.maxTokens }
                : {}),
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
    let finishReason: StreamChatResult['finishReason'] | null = null
    let rawStopReason: string | undefined
    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens: number | undefined
    const toolCalls: StreamedToolCall[] = []
    const streamedCalls = new ResponsesToolCalls()
    const reader = response.body.getReader()
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

      if (eventType === 'response.output_text.delta') {
        const delta = String(parsed.delta ?? '')
        content += delta
        try {
          onDelta(delta)
        } catch (error) {
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

      if (streamedCalls.handle(parsed)) return

      if (
        eventType === 'response.completed' ||
        eventType === 'response.incomplete'
      ) {
        const item = (parsed.response ?? parsed.item) as
          Record<string, unknown> | undefined
        if (item) {
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
        throw new ProviderError(
          'provider',
          `responses api error: ${JSON.stringify(parsed.error ?? 'unknown')}`,
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

    // 将 toolCalls 从 map 转换为数组，并还原 canonical 名。
    for (const toolCall of streamedCalls.values()) {
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
