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
 * canonical ModelMessage 投影为 Anthropic Messages 方言：
 * system 消息单独提取，assistant 的工具调用回到 content 块，
 * 工具结果走 content type=tool_result。
 */
function toAnthropicMessages(
  messages: ModelMessage[],
  canonicalToProvider: ReadonlyMap<string, string>,
): { system: string | undefined; messages: Array<Record<string, unknown>> } {
  let system: string | undefined
  const result: Array<Record<string, unknown>> = []

  for (const message of messages) {
    if (message.role === 'system') {
      // Anthropic system 是顶层字段；多条 system 合并。
      system = system ? `${system}\n${message.content}` : message.content
      continue
    }
    if (message.role === 'user') {
      result.push({ role: 'user', content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      if (message.toolCalls.length === 0) {
        result.push({ role: 'assistant', content: message.content })
      } else {
        const content: Array<Record<string, unknown>> = []
        if (message.content) {
          content.push({ type: 'text', text: message.content })
        }
        for (const call of message.toolCalls) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: canonicalToProvider.get(call.name) ?? call.name,
            input: tryParseJson(call.arguments),
          })
        }
        result.push({ role: 'assistant', content })
      }
      continue
    }
    if (message.role === 'tool') {
      // Anthropic 用 content type=tool_result 表达工具结果。
      // 找到最后一条 assistant 消息，在其后插入 tool_result。
      let lastAssistant: Record<string, unknown> | undefined
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].role === 'assistant') {
          lastAssistant = result[i]
          break
        }
      }
      if (lastAssistant && Array.isArray(lastAssistant.content)) {
        lastAssistant.content.push({
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        })
      } else {
        // 兜底：如果找不到 assistant 消息，创建一个 user 消息包裹 tool_result。
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: message.content,
            },
          ],
        })
      }
    }
  }

  return { system, messages: result }
}

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
}

function mapStopReason(
  reason: string | null | undefined,
): 'stop' | 'length' | 'content_filter' | 'tool_calls' {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'max_tokens') return 'length'
  if (reason === 'tool_use') return 'tool_calls'
  return 'stop'
}

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

  const canonicalToolNames = (options.tools ?? []).map((tool) => tool.name)
  const messageToolNames = options.messages.flatMap((msg) =>
    msg.role === 'assistant' ? msg.toolCalls.map((c) => c.name) : [],
  )
  const { canonicalToProvider, providerToCanonical } = buildToolNameMapping(
    canonicalToolNames,
    messageToolNames,
  )

  const { system, messages } = toAnthropicMessages(
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
              max_tokens: options.maxTokens ?? 4096,
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
    let finishReason:
      'stop' | 'length' | 'content_filter' | 'tool_calls' | null = null
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
          finishReason = mapStopReason(String(delta.stop_reason))
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
    for (const [, toolCall] of toolCallById) {
      toolCalls.push({
        ...toolCall,
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
      finishReason,
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
