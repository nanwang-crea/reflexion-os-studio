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

const SUMMARY_MAX_OUTPUT_TOKENS = 4096
const SUMMARY_MAX_INPUT_TOKENS = 32_000
const MAX_SUMMARY_CHUNKS = 32

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
    const result = await streamChat(
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
    signal.throwIfAborted()
    if (result.finishReason !== 'stop' || result.toolCalls.length > 0)
      throw new Error('checkpoint summary: response did not complete as text')
    const text = result.content.trim()
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start)
      throw new Error('checkpoint summary: no JSON object in response')
    summary = sanitizeSummary(JSON.parse(text.slice(start, end + 1)))
  }
  if (count === 0) throw new Error('checkpoint summary: no source content')
  return summary
}
