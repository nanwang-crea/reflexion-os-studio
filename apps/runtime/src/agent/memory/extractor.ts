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
 * 构建 Run 的提取用对话记录：user/assistant 正文 + 工具调用摘要。
 * 记录截断到尾部（最近的交互最有价值）。
 */
export function buildRunTranscript(store: Store, run: Run): string {
  const messages = store.messages
    .listBySession(run.sessionId)
    .filter((message) => message.runId === run.id)
  const toolCallsByMessage = new Map<string, string[]>()
  for (const call of store.toolCalls.listByRun(run.id)) {
    if (call.messageId === null) continue
    const lines = toolCallsByMessage.get(call.messageId) ?? []
    lines.push(`[工具] ${call.toolName} ${JSON.stringify(call.args ?? {})}`)
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

/**
 * 提取候选记忆（一次 LLM 调用）。失败与解析异常由调用方决定降级——
 * 记忆提取永远不能影响主对话。
 */
export async function extractMemoryCandidates(
  transcript: string,
  provider: ProviderRuntimeConfig,
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
      signal: new AbortController().signal,
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
