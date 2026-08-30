import type { ModelMessage } from '@reflexion-os-studio/agent-core'
import type { Memory } from '@reflexion-os-studio/contracts'
import { streamChatCompletion } from '../../provider.js'
import type { ProviderRuntimeConfig } from '../context.js'
import { MEMORY_MERGER_SYSTEM_PROMPT } from '../prompts/index.js'
import { parseJsonLoose } from './filter.js'
import type { MemoryCandidate } from './extractor.js'
import { SIMILARITY_THRESHOLD, jaccardSimilarity } from './similarity.js'

export type MergeAction = 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'NOOP'

export interface MemoryDecision {
  index: number
  action: MergeAction
  targetId: string | null
  content: string | null
}

/** 每个候选的相似既有记忆（同 scope 范围内二元组相似度筛选）。 */
export interface CandidateSimilarity {
  index: number
  candidate: MemoryCandidate
  similar: Memory[]
}

const SIMILAR_PER_CANDIDATE = 5
const SIMILAR_TOTAL_CAP = 30

/**
 * 逐候选查找相似既有记忆。相似只在同一 scope 范围内比较：
 * 跨范围的同文内容不构成 UPDATE/SUPERSEDE 的目标。
 */
export function findSimilarExisting(
  memories: Memory[],
  candidates: MemoryCandidate[],
  scopeFilterFor: (candidate: MemoryCandidate) => (memory: Memory) => boolean,
): CandidateSimilarity[] {
  return candidates.map((candidate, index) => {
    const filter = scopeFilterFor(candidate)
    const similar = memories
      .filter(filter)
      .map((memory) => ({
        memory,
        score: jaccardSimilarity(candidate.content, memory.content),
      }))
      .filter((entry) => entry.score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, SIMILAR_PER_CANDIDATE)
      .map((entry) => entry.memory)
    return { index, candidate, similar }
  })
}

/**
 * 合并决策（一次 LLM 调用，批量决定全部候选）。
 * 决策失败时调用方降级：无相似记忆的候选按 ADD 处理，其余跳过。
 */
export async function decideMerges(
  similarities: CandidateSimilarity[],
  provider: ProviderRuntimeConfig,
): Promise<MemoryDecision[]> {
  const candidates = similarities.map((entry) => entry.candidate)
  if (candidates.length === 0) return []
  const existing: Memory[] = []
  for (const entry of similarities) {
    for (const memory of entry.similar) {
      if (!existing.some((item) => item.id === memory.id)) existing.push(memory)
    }
    if (existing.length >= SIMILAR_TOTAL_CAP) break
  }
  const candidateLines = candidates
    .map(
      (item, index) => `${index}. [${item.scope}|${item.kind}] ${item.content}`,
    )
    .join('\n')
  const existingLines =
    existing.length === 0
      ? '（无）'
      : existing
          .map(
            (memory) =>
              `- id=${memory.id} [${memory.scope}|${memory.kind}] ${memory.content}`,
          )
          .join('\n')
  const userMessage: ModelMessage = {
    role: 'user',
    content: `[记忆候选]\n${candidateLines}\n\n[既有记忆]\n${existingLines}`,
  }
  const result = await streamChatCompletion(
    {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [
        { role: 'system', content: MEMORY_MERGER_SYSTEM_PROMPT },
        userMessage,
      ],
      signal: new AbortController().signal,
      timeoutMs: 60_000,
    },
    () => {},
  )
  return sanitizeDecisions(parseJsonLoose(result.content), candidates, existing)
}

/** 校验并清洗 LLM 决策：index 越界、未知 targetId、UPDATE/SUPERSEDE 缺内容的一律丢弃。 */
export function sanitizeDecisions(
  raw: unknown,
  candidates: MemoryCandidate[],
  similarExisting: Memory[],
): MemoryDecision[] {
  if (!Array.isArray(raw)) return []
  const knownIds = new Set(similarExisting.map((memory) => memory.id))
  const decisions: MemoryDecision[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const index = Number(record.index)
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      continue
    }
    const action = String(record.action ?? 'NOOP')
    if (!['ADD', 'UPDATE', 'SUPERSEDE', 'NOOP'].includes(action)) continue
    const targetId =
      typeof record.targetId === 'string' && knownIds.has(record.targetId)
        ? record.targetId
        : null
    if (
      (action === 'UPDATE' || action === 'SUPERSEDE') &&
      (targetId === null ||
        typeof record.content !== 'string' ||
        record.content.trim() === '')
    ) {
      continue
    }
    decisions.push({
      index,
      action: action as MergeAction,
      targetId,
      content:
        typeof record.content === 'string' && record.content.trim() !== ''
          ? record.content.trim()
          : null,
    })
  }
  return decisions
}
