import {
  estimateMessageTokens,
  type ContextFrame,
  type ModelMessage,
} from '@reflexion-os-studio/agent-core'
import type { ContextCheckpointSummary } from '@reflexion-os-studio/contracts'
import { streamChat } from '../../../provider.js'
import {
  checkRequestBudget,
  contextBudgetFor,
  type ProviderRuntimeConfig,
} from '../budget.js'
import { CHECKPOINT_SUMMARY_SYSTEM_PROMPT } from '../../prompts/index.js'
import { sanitizeSummary } from './summary.js'
import { transcriptChunks } from './transcript.js'
import { observeModelInvocation } from '../../../diagnostics/model-invocation.js'
import type { Store } from '../../../store/index.js'

export const SUMMARY_MAX_OUTPUT_TOKENS = 8192
const SUMMARY_MAX_INPUT_TOKENS = 32_000
const MAX_SUMMARY_CHUNKS = 32

/** 模型输出可能包在代码块/前后说明中；只取其中的 JSON 对象。 */
function extractJsonObject(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1]?.trim() ?? text
  try {
    return JSON.parse(candidate) as unknown
  } catch {
    // 模型可能输出说明文字包裹 JSON；退化为首尾花括号范围。
  }
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

function requestMessages(
  summary: ContextCheckpointSummary | null,
  chunk: string,
): ModelMessage[] {
  return [
    { role: 'system', content: CHECKPOINT_SUMMARY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        summary === null
          ? '旧摘要：null（无既有摘要）'
          : `旧摘要：${JSON.stringify(summary)}`,
        '新增对话片段（原文按顺序分批；一条消息可能跨批次）：',
        chunk,
      ].join('\n\n'),
    },
  ]
}

/** Commit is owned by ensureCheckpoint, after the entire incremental chain succeeds. */
export async function summarizeCheckpointFrames(
  provider: ProviderRuntimeConfig,
  input: {
    previousSummary: ContextCheckpointSummary | null
    newFrames: ContextFrame[]
    signal: AbortSignal
    diagnostics?: { store: Store; sessionId: string }
  },
): Promise<unknown> {
  const maxTokens = Math.min(
    provider.maxTokens ?? SUMMARY_MAX_OUTPUT_TOKENS,
    SUMMARY_MAX_OUTPUT_TOKENS,
  )
  const inputBudget = contextBudgetFor({
    ...provider,
    maxTokens,
    contextBudget: SUMMARY_MAX_INPUT_TOKENS,
  })
  let summary = input.previousSummary
  let count = 0
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  const chunks = transcriptChunks(input.newFrames, () => {
    const available =
      inputBudget - estimateMessageTokens(requestMessages(summary, '')) - 128
    if (available < 256)
      throw new Error('checkpoint summary: prior summary exceeds input budget')
    return available
  })
  for (const chunk of chunks) {
    signal.throwIfAborted()
    count += 1
    if (count > MAX_SUMMARY_CHUNKS)
      throw new Error('checkpoint summary: too many input batches')
    const messages = requestMessages(summary, chunk)
    checkRequestBudget(messages, {
      ...provider,
      maxTokens,
      contextBudget: SUMMARY_MAX_INPUT_TOKENS,
    })
    const request = () =>
      streamChat(
        {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          headers: provider.headers,
          messages,
          signal,
          maxTokens,
          timeoutMs: Math.min(provider.timeoutMs ?? 60_000, 60_000),
          maxRetries: Math.min(provider.maxRetries ?? 1, 1),
          retryBackoffInitialMs: provider.retryBackoffInitialMs,
          retryBackoffMaxMs: provider.retryBackoffMaxMs,
        },
        provider.apiFormat,
        () => {},
      )
    const result = input.diagnostics
      ? await observeModelInvocation(
          input.diagnostics.store,
          {
            sessionId: input.diagnostics.sessionId,
            runId: null,
            messageId: null,
            providerId: provider.providerId ?? null,
            model: provider.model,
            purpose: 'summary',
            signal,
            estimatedInputTokens: estimateMessageTokens(messages),
            contextWindow: provider.contextWindow,
          },
          request,
        )
      : await request()
    signal.throwIfAborted()
    // 输出被截断时 JSON 必然不完整；用稳定错误码让上层退避，而不是把
    // 半截 JSON 当摘要提交。
    if (result.finishReason === 'length')
      throw new Error('checkpoint summary: output truncated (length)')
    if (result.finishReason !== 'stop' || result.toolCalls.length > 0)
      throw new Error('checkpoint summary: response did not complete as text')
    const parsed = extractJsonObject(result.content.trim())
    if (parsed === null)
      throw new Error('checkpoint summary: no JSON object in response')
    summary = sanitizeSummary(parsed)
  }
  if (count === 0) throw new Error('checkpoint summary: no source content')
  return summary
}
