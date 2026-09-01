import type {
  FinishReason,
  RuntimeErrorCode,
  ToolSpec,
  Usage,
} from '@reflexion-os-studio/contracts'
import type { ModelMessage } from '@reflexion-os-studio/agent-core'

const DEFAULT_TIMEOUT_MS = 120_000
/** 请求建立阶段失败(网络/限流/服务端短暂故障)的自动重试次数与退避。 */
const DEFAULT_MAX_RETRIES = 2
const RETRY_BACKOFF_MS = [1_000, 2_500]

/** 429 限流与 5xx 短暂故障可重试；认证/配置类错误重试无意义。 */
function shouldRetryStatus(code: number): boolean {
  return code === 429 || code >= 500
}

/** 可取消的等待；signal 已中止时立即抛 AbortError。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class ProviderError extends Error {
  readonly code: RuntimeErrorCode

  constructor(code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

/** 流式聚合后的一条工具调用；arguments 为原始 JSON 字符串，由调用方校验。 */
export interface StreamedToolCall {
  id: string
  name: string
  arguments: string
}

export interface StreamChatOptions {
  baseUrl: string
  apiKey: string
  model: string
  messages: ModelMessage[]
  signal: AbortSignal
  timeoutMs?: number
  /** 传入时限制补全长度（连接测试用 1，避免无谓消耗）。 */
  maxTokens?: number
  /** 采样温度；缺省由服务端决定。 */
  temperature?: number
  /** 请求建立阶段失败自动重试次数；连接测试等场景传 0 快速失败。 */
  maxRetries?: number
  /** Agent 侧 canonical 工具声明；适配层投影为 OpenAI function 格式。 */
  tools?: ToolSpec[]
}

export interface StreamChatResult {
  content: string
  reasoning: string
  finishReason: FinishReason
  usage?: Usage
  toolCalls: StreamedToolCall[]
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
  if (
    reason === 'stop' ||
    reason === 'length' ||
    reason === 'content_filter' ||
    reason === 'tool_calls'
  ) {
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

/**
 * 部分 Provider(如某些聚合/中转服务)只接受 a-z A-Z 0-9 _ - 的工具名，
 * 而内部 canonical 名含点号(web.fetch)或斜杠(MCP 的 serverId/toolName)。
 * 在 Provider 方言边界做一次确定性清洗，并维护 清洗名 ⇄ 原始名 双向映射：
 * 发送给模型用清洗名，模型回传的工具调用再映射回原始名交给 ToolRegistry，
 * 从而不污染内部/MCP 原始协议名。
 */
const SAFE_NAME_RE = /[^a-zA-Z0-9_-]/g
const MAX_SAFE_NAME_LEN = 64

function sanitizeToolName(name: string): string {
  const cleaned = name.replace(SAFE_NAME_RE, '_')
  return (cleaned === '' ? '_' : cleaned).slice(0, MAX_SAFE_NAME_LEN)
}

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

export async function streamChatCompletion(
  options: StreamChatOptions,
  onDelta: (delta: string) => void,
  onReasoningDelta?: (delta: string) => void,
): Promise<StreamChatResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = AbortSignal.any([options.signal, timeout])

  // 请求建立阶段的重试:网络错误、429、5xx。流读取开始后不重试
  // (已吐出的 delta 无法回滚),避免 UI 文本重复。
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES

  // canonical 名 ⇄ Provider 清洗名的双向映射：同一请求内固定，只构建一次。
  // 清洗后可能重名(canonical 点号/斜杠不同但清洗结果相同)，冲突时追加数字后缀。
  const canonicalToProvider = new Map<string, string>()
  const providerToCanonical = new Map<string, string>()
  const usedNames = new Set<string>()
  const canonicalNames = new Set((options.tools ?? []).map((tool) => tool.name))
  for (const message of options.messages) {
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls) canonicalNames.add(call.name)
  }
  for (const canonicalName of canonicalNames) {
    let safeName = sanitizeToolName(canonicalName)
    let suffix = 2
    while (usedNames.has(safeName)) {
      const suffixText = `_${suffix}`
      const base = sanitizeToolName(canonicalName).slice(
        0,
        MAX_SAFE_NAME_LEN - suffixText.length,
      )
      safeName = `${base}${suffixText}`
      suffix += 1
    }
    usedNames.add(safeName)
    canonicalToProvider.set(canonicalName, safeName)
    providerToCanonical.set(safeName, canonicalName)
  }

  let attempt = 0
  let response: Response
  for (;;) {
    try {
      // canonical 工具声明投影为 OpenAI function calling 方言，名称用清洗后的合法名。
      const tools =
        options.tools && options.tools.length > 0
          ? options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: canonicalToProvider.get(tool.name) ?? tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
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
            ...(tools !== undefined ? { tools } : {}),
          }),
          signal,
        },
      )
    } catch (error) {
      if (isAbort(error)) throw error
      if (attempt < maxRetries) {
        attempt += 1
        await sleep(
          RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)],
          signal,
        )
        continue
      }
      throw new ProviderError(
        'network',
        `provider request failed: ${String(error)}`,
      )
    }

    if (response.ok) break
    const detail = await response.text().catch(() => '')
    if (shouldRetryStatus(response.status) && attempt < maxRetries) {
      attempt += 1
      await sleep(
        RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)],
        signal,
      )
      continue
    }
    throw new ProviderError(
      mapHttpStatus(response.status),
      `provider responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
  if (!response.body) {
    throw new ProviderError('provider', 'provider response has no body')
  }

  let content = ''
  let reasoning = ''
  let finishReason: FinishReason = 'stop'
  let usage: Usage | undefined
  const toolCallByIndex = new Map<number, StreamedToolCall>()
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
        delta?: {
          content?: string
          // 推理模型的思考增量：DeepSeek/Qwen/GLM 用 reasoning_content，
          // OpenRouter 等用 reasoning。
          reasoning_content?: string
          reasoning?: string
          // 工具调用增量：按 index 分片累积 id/name/arguments。
          tool_calls?: {
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }[]
        }
        finish_reason?: string | null
      }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    const delta = parsed.choices?.[0]?.delta
    const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning
    if (reasoningDelta) {
      reasoning += reasoningDelta
      onReasoningDelta?.(reasoningDelta)
    }
    if (delta?.content) {
      content += delta.content
      onDelta(delta.content)
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

  const toolCalls = [...toolCallByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, toolCall]) => ({
      ...toolCall,
      name: providerToCanonical.get(toolCall.name) ?? toolCall.name,
    }))

  return { content, reasoning, finishReason, usage, toolCalls }
}
