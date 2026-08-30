import type { Store } from '../../store/index.js'
import { embedTexts, resolveEmbeddingProvider } from '../../embedding.js'
import type { Memory } from '@reflexion-os-studio/contracts'

/** 注入上下文的记忆 token 预算与条数上限。 */
export const MEMORY_CONTEXT_BUDGET = 800
export const MEMORY_CONTEXT_MAX_ITEMS = 8

/** 关键词项 / 向量项进入结果的相关性门槛；pinned 记忆始终保留。 */
const FTS_HIT_SCORE = 0.6
const COSINE_RELEVANT = 0.2

const SCOPE_LABELS: Record<string, string> = {
  session: '会话',
  project: '项目',
  user: '用户',
}

/** 召回 token 估算：CJK≈1 token/字，其余约 4 字符 1 token（与 agent-core 口径一致）。 */
function estimateTextTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? [])
    .length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

const CJK_PATTERN = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

function containsCjk(text: string): boolean {
  return CJK_PATTERN.test(text)
}

/**
 * 查询拆词：标点/空白切分后逐词检索。
 * CJK 长词追加 4 字滑窗（步长 2）——trigram 索引只能命中 ≥3 字符的子串短语，
 * 整句查询直接 MATCH 基本命不中；纯拉丁词保持原样（≥3 字符才有意义）。
 */
export function extractQueryTerms(query: string, limit = 8): string[] {
  const base = query
    .split(/[\s，。！？、：；,.!?;:'"“”‘’()（）[\]{}]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term.length <= 24)
  const terms: string[] = []
  for (const term of base) {
    terms.push(term)
    if (term.length > 6 && containsCjk(term)) {
      for (let i = 0; i + 4 <= term.length; i += 2) {
        terms.push(term.slice(i, i + 4))
      }
    }
  }
  return [...new Set(terms)].slice(0, limit)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * bm25 相关性转 [0,1) 分数。FTS5 的 bm25 越相关数值越小（越负），
 * 取绝对值后必须用单调递增映射，否则最相关的条目反而得分最低。
 */
export function ftsScoreFromRank(rank: number): number {
  return 1 - 1 / (1 + Math.abs(rank))
}

/**
 * 混合召回：FTS 关键词 + embedding 余弦 + recency 衰减，pinned 置顶。
 * 无 embedding 配置（或模型不一致）时自动退化为 FTS + recency；
 * 任何失败都应向上抛出由调用方兜底——召回失败只影响记忆注入，不影响对话。
 */
export async function recallMemories(
  store: Store,
  sessionId: string,
): Promise<Memory[]> {
  const session = store.sessions.get(sessionId)
  if (!session) return []
  const scopes: {
    scope: 'session' | 'project' | 'user'
    scopeId: string | null
  }[] = [{ scope: 'session', scopeId: sessionId }]
  if (session.projectId !== null) {
    scopes.push({ scope: 'project', scopeId: session.projectId })
  }
  scopes.push({ scope: 'user', scopeId: null })

  const candidates = store.memories.listRecallCandidates(scopes)
  if (candidates.length === 0) return []

  const latestUser = [...store.messages.listBySession(sessionId)]
    .reverse()
    .find((message) => message.role === 'user')
  const query = latestUser?.content ?? ''

  const scores = new Map<string, number>()
  if (query !== '') {
    for (const term of extractQueryTerms(query)) {
      for (const hit of store.memories.searchFts(term, 30)) {
        const base =
          hit.rank === null ? FTS_HIT_SCORE : ftsScoreFromRank(hit.rank)
        scores.set(hit.id, Math.max(scores.get(hit.id) ?? 0, base))
      }
    }
  }

  // 查询向量：仅当候选中确实存在向量时才发起网络调用。
  const embedding = resolveEmbeddingProvider(store)
  let queryVector: number[] | null = null
  if (embedding && candidates.some((item) => item.vector !== null)) {
    try {
      const [vector] = await embedTexts({
        baseUrl: embedding.baseUrl,
        apiKey: embedding.apiKey,
        model: embedding.model,
        inputs: [query === '' ? sessionId : query],
        timeoutMs: 10_000,
      })
      queryVector = vector ?? null
    } catch {
      // embedding 失败不阻塞召回：退化为 FTS + recency。
      queryVector = null
    }
  }

  const now = Date.now()
  const scored = candidates.map((item) => {
    const fts = scores.get(item.memory.id) ?? 0
    const cosine =
      queryVector !== null &&
      item.vector !== null &&
      item.vectorModel === embedding?.model
        ? cosineSimilarity(queryVector, item.vector)
        : null
    const ageDays =
      (now - new Date(item.memory.createdAt).getTime()) / 86_400_000
    const recency = Math.exp(-Math.max(0, ageDays) / 21)
    const pinned = item.memory.status === 'pinned'
    const relevant =
      pinned || fts > 0 || (cosine !== null && cosine >= COSINE_RELEVANT)
    const semantic =
      cosine === null
        ? 0.6 * fts + 0.25 * recency
        : 0.5 * cosine + 0.3 * fts + 0.2 * recency
    return {
      memory: item.memory,
      score: relevant ? semantic + (pinned ? 0.15 : 0) : -1,
    }
  })

  scored.sort((a, b) => b.score - a.score)
  const selected: Memory[] = []
  let tokens = 0
  for (const entry of scored) {
    if (entry.score < 0) break
    if (selected.length >= MEMORY_CONTEXT_MAX_ITEMS) break
    const cost = estimateTextTokens(entry.memory.content) + 6
    if (tokens + cost > MEMORY_CONTEXT_BUDGET) continue
    tokens += cost
    selected.push(entry.memory)
  }
  return selected
}

/** 渲染为注入 system prompt 的记忆块；空结果返回空串。 */
export function renderMemoryBlock(memories: Memory[]): string {
  if (memories.length === 0) return ''
  const lines = memories.map(
    (memory) =>
      `- [${SCOPE_LABELS[memory.scope] ?? memory.scope}] ${memory.content}`,
  )
  return `[相关记忆 · 自动召回]\n${lines.join('\n')}`
}

/** 便捷入口：召回 + 渲染；异常吞掉返回空串（记忆失败不拦对话）。 */
export async function buildMemoryBlock(
  store: Store,
  sessionId: string,
): Promise<string> {
  const memories = await recallMemories(store, sessionId)
  return renderMemoryBlock(memories)
}
