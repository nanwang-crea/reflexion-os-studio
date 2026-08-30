import type { FinishReason, Usage } from '@reflexion-os-studio/contracts'
import type { RuntimeErrorCode } from '@reflexion-os-studio/contracts'

const DEFAULT_TIMEOUT_MS = 120_000

export class ProviderError extends Error {
  readonly code: RuntimeErrorCode

  constructor(code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

export interface ChatContextMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamChatOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatContextMessage[]
  signal: AbortSignal
  timeoutMs?: number
  /** 传入时限制补全长度（连接测试用 1，避免无谓消耗）。 */
  maxTokens?: number
}

export interface StreamChatResult {
  content: string
  finishReason: FinishReason
  usage?: Usage
}

function mapHttpStatus(code: number): RuntimeErrorCode {
  if (code === 401 || code === 403) return 'authentication'
  if (code === 429) return 'rate_limit'
  if (code === 404) return 'configuration'
  if (code >= 500) return 'provider'
  return 'configuration'
}

function mapFinishReason(
  reason: string | null | undefined,
): FinishReason | null {
  if (reason === 'stop' || reason === 'length' || reason === 'content_filter') {
    return reason
  }
  return null
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
}

export async function streamChatCompletion(
  options: StreamChatOptions,
  onDelta: (delta: string) => void,
): Promise<StreamChatResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = AbortSignal.any([options.signal, timeout])

  let response: Response
  try {
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
          messages: options.messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(options.maxTokens !== undefined
            ? { max_tokens: options.maxTokens }
            : {}),
        }),
        signal,
      },
    )
  } catch (error) {
    if (isAbort(error)) throw error
    throw new ProviderError(
      'network',
      `provider request failed: ${String(error)}`,
    )
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new ProviderError(
      mapHttpStatus(response.status),
      `provider responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
  if (!response.body) {
    throw new ProviderError('provider', 'provider response has no body')
  }

  let content = ''
  let finishReason: FinishReason = 'stop'
  let usage: Usage | undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') return
    let parsed: {
      choices?: {
        delta?: { content?: string }
        finish_reason?: string | null
      }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    const delta = parsed.choices?.[0]?.delta?.content
    if (delta) {
      content += delta
      onDelta(delta)
    }
    const mapped = mapFinishReason(parsed.choices?.[0]?.finish_reason)
    if (mapped) finishReason = mapped
    if (parsed.usage) {
      usage = {
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
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
  } catch (error) {
    if (isAbort(error)) throw error
    throw new ProviderError(
      'network',
      `provider stream failed: ${String(error)}`,
    )
  }

  return { content, finishReason, usage }
}
