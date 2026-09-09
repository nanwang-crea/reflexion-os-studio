import type { Store } from '../../store/index.js'
import { embedTexts, resolveEmbeddingProvider } from './embedding.js'
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
 * 混合召回（W6 复合版）：FTS 关键词 + embedding 余弦 + recency 衰减，
 * pinned 置顶。查询文本为复合拼接（当前用户消息 + 最近 3 条用户消息 +
 * 当前 Checkpoint goal/pending + 活动 Plan 目标），短消息（"继续"）仍能
 * 带上真实任务语义。embedding 查询 500ms deadline：超时立即用
 * FTS + recency + pinned 返回，不等待。无 embedding 配置时自动退化。
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

  const query = buildCompositeQuery(store, sessionId)

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

  // 查询向量：仅当候选中确实存在向量时才发起网络调用；500ms deadline 硬限。
  const embedding = resolveEmbeddingProvider(store)
  let queryVector: number[] | null = null
  if (embedding && candidates.some((item) => item.vector !== null)) {
    const embeddingController = new AbortController()
    const deadline = setTimeout(() => embeddingController.abort(), 500)
    try {
      const [vector] = await embedTexts({
        baseUrl: embedding.baseUrl,
        apiKey: embedding.apiKey,
        model: embedding.model,
        inputs: [query === '' ? sessionId : query],
        timeoutMs: 500,
        signal: embeddingController.signal,
      })
      queryVector = vector ?? null
    } catch {
      // embedding 失败/超时不阻塞召回：退化为 FTS + recency。
      queryVector = null
    } finally {
      clearTimeout(deadline)
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

/**
 * 复合召回查询（§9.5）：当前用户消息 + 最近 3 条用户消息 +
 * Checkpoint goal/pending + 活动 Plan goal。总长截断 1200 字符——
 * "继续"/"按刚才说的做"等短消息仍能携带真实任务语义。
 */
export function buildCompositeQuery(store: Store, sessionId: string): string {
  const parts: string[] = []
  const messages = store.messages
    .listBySession(sessionId)
    .filter((message) => message.role === 'user' && message.content !== '')
  const recentUsers = messages.slice(-3).reverse()
  if (recentUsers.length > 0) {
    parts.push(recentUsers[0].content)
  }
  for (const older of recentUsers.slice(1)) {
    parts.push(older.content)
  }
  const checkpoint = store.contextCheckpoints.get(sessionId)
  if (checkpoint !== null) {
    if (checkpoint.summary.goal !== null) parts.push(checkpoint.summary.goal)
    parts.push(...checkpoint.summary.pending)
  }
  const plan = store.plans
    .listBySession(sessionId)
    .find((candidate) => candidate.status === 'active')
  if (plan !== undefined) {
    parts.push(plan.goal)
    const inProgress = plan.steps.find((step) => step.status === 'in_progress')
    if (inProgress !== undefined) parts.push(inProgress.title)
  }
  return parts.join('\n').slice(0, 1200)
}

/** 便捷入口：召回 + 渲染；异常吞掉返回空串（记忆失败不拦对话）。 */
export async function buildMemoryBlock(
  store: Store,
  sessionId: string,
): Promise<string> {
  const memories = await recallMemories(store, sessionId)
  return renderMemoryBlock(memories)
}
