import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import type { MemoryKind, Run } from '@reflexion-os-studio/contracts'
import { streamChatCompletion } from '../../provider.js'
import type { ProviderRuntimeConfig } from '../context.js'
import { MEMORY_EXTRACTOR_SYSTEM_PROMPT } from '../prompts/index.js'
import type { Store } from '../../store/index.js'
import { containsSecretLike, parseJsonLoose } from './filter.js'

/** 记忆候选：合并决策前的中间表示；scope 限定 session/project（user 级待确认流程）。 */
export interface MemoryCandidate {
  kind: MemoryKind
  scope: 'session' | 'project'
  content: string
  confidence: number
}

const MAX_CANDIDATES = 8
const TRANSCRIPT_MAX_CHARS = 12_000

const KINDS = new Set(['fact', 'preference', 'procedure'])

/**
 * 构建 Run 的提取用对话记录（W6 脱敏版）：
 * - user/assistant 正文；
 * - 工具名 + 脱敏参数摘要（长文本/疑似机密折叠）；
 * - ToolCall 状态与 errorCode；
 * - 结果以截断摘要进入（不是完整原文）。
 * 不包含 reasoning、ApprovalGrant、密钥或完整大文件内容。
 * 记录截断到尾部（最近的交互最有价值）。
 */
export function buildRunTranscript(store: Store, run: Run): string {
  const messages = store.messages
    .listBySession(run.sessionId)
    .filter((message) => message.runId === run.id)
  const toolCallsByMessage = new Map<string, string[]>()
  for (const call of store.toolCalls.listByRun(run.id)) {
    if (call.messageId === null) continue
    const status =
      call.status === 'completed'
        ? 'ok'
        : call.status === 'failed'
          ? `error(${call.errorCode ?? 'tool_error'})`
          : call.status
    const lines = toolCallsByMessage.get(call.messageId) ?? []
    lines.push(
      `[工具] ${call.toolName}(${summarizeArgsForTranscript(call.args)}) → ${status} ${summarizeResultForTranscript(call)}`,
    )
    toolCallsByMessage.set(call.messageId, lines)
  }
  const lines: string[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user' && message.content !== '') {
      lines.push(`user: ${message.content}`)
      continue
    }
    if (message.role === 'assistant') {
      for (const toolLine of toolCallsByMessage.get(message.id) ?? []) {
        lines.push(toolLine)
      }
      if (message.content !== '') lines.push(`assistant: ${message.content}`)
    }
  }
  const transcript = lines.join('\n')
  return transcript.length > TRANSCRIPT_MAX_CHARS
    ? transcript.slice(-TRANSCRIPT_MAX_CHARS)
    : transcript
}

/** 工具参数脱敏摘要：只保留短标量键值，长文本/嵌套折叠；疑似机密整体折叠。 */
function summarizeArgsForTranscript(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (containsSecretLike(value)) {
        parts.push(`${key}: <redacted>`)
      } else {
        parts.push(
          `${key}: ${value.length > 80 ? `${value.slice(0, 80)}…` : value}`,
        )
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${value}`)
    } else {
      parts.push(`${key}: <${typeof value}>`)
    }
  }
  return parts.join(', ')
}

/** 工具结果摘要：ok 折叠为短摘要，error 保留错误码；疑似机密折叠。 */
function summarizeResultForTranscript(call: {
  status: string
  result: unknown
}): string {
  if (call.status !== 'completed') return ''
  const text =
    typeof call.result === 'string'
      ? call.result
      : JSON.stringify(call.result ?? '')
  if (text === '' || text === 'null') return ''
  const clipped = text.length > 120 ? `${text.slice(0, 120)}…` : text
  return containsSecretLike(clipped) ? '<redacted>' : clipped
}

/**
 * 提取候选记忆（一次 LLM 调用）。失败与解析异常由调用方决定降级——
 * 记忆提取永远不能影响主对话。signal 支持前台抢占（W6 worker）。
 */
export async function extractMemoryCandidates(
  transcript: string,
  provider: ProviderRuntimeConfig,
  signal: AbortSignal = new AbortController().signal,
): Promise<MemoryCandidate[]> {
  const userMessage: ModelMessage = {
    role: 'user',
    content: `[对话记录]\n${transcript}`,
  }
  const result = await streamChatCompletion(
    {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [
        { role: 'system', content: MEMORY_EXTRACTOR_SYSTEM_PROMPT },
        userMessage,
      ],
      signal,
      timeoutMs: 60_000,
    },
    () => {},
  )
  return sanitizeCandidates(parseJsonLoose(result.content))
}

/** 校验/清洗模型输出：形状不对的丢弃，疑似机密的丢弃，超额截断。 */
export function sanitizeCandidates(raw: unknown): MemoryCandidate[] {
  if (!Array.isArray(raw)) return []
  const candidates: MemoryCandidate[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.content !== 'string') continue
    const content = record.content.trim()
    if (content === '' || content.length > 200) continue
    if (containsSecretLike(content)) continue
    const kind = String(record.kind ?? 'fact')
    const scope = String(record.scope ?? 'session')
    if (!KINDS.has(kind)) continue
    if (scope !== 'session' && scope !== 'project') continue
    const confidenceRaw = Number(record.confidence)
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.8
    candidates.push({
      kind: kind as MemoryKind,
      scope: scope as 'session' | 'project',
      content,
      confidence,
    })
    if (candidates.length >= MAX_CANDIDATES) break
  }
  return candidates
}
