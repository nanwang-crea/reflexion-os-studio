import type { Memory, Run, Session } from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../../events.js'
import { embedTexts, resolveEmbeddingProvider } from '../../embedding.js'
import type { Store } from '../../store/index.js'
import type { ProviderRuntimeConfig } from '../context.js'
import {
  buildRunTranscript,
  extractMemoryCandidates,
  type MemoryCandidate,
} from './extractor.js'
import {
  decideMerges,
  findSimilarExisting,
  type CandidateSimilarity,
} from './merge.js'

/**
 * A2 Memory 服务：mem0 式「提取 → 合并 → 存储 → 召回」管线的写侧编排。
 * Run 成功完成后由 runner 异步触发（fire-and-forget）；任何失败只写 stderr，
 * 绝不影响主对话。召回见 recall.ts（ContextBuilder 注入）。
 *
 * 写入策略（AGENT-PLATFORM-PLAN §5）：session/project 自动写入、记忆页可撤销；
 * user 级需确认，待确认流程落地前提取器不产出 user 候选。
 */
export class MemoryService {
  constructor(private readonly store: Store) {}

  async processRun(input: {
    run: Run
    provider: ProviderRuntimeConfig
    emitter: RunEventEmitter
  }): Promise<void> {
    const { run, provider, emitter } = input
    const session = this.store.sessions.get(run.sessionId)
    if (!session) return

    const transcript = buildRunTranscript(this.store, run)
    if (transcript.trim() === '') return

    const candidates = await extractMemoryCandidates(transcript, provider)
    if (candidates.length === 0) return

    const written = await this.applyCandidates(
      candidates,
      session,
      run.id,
      provider,
    )
    if (written.length === 0) return
    emitter.next({ type: 'memory.written', memories: written })
  }

  /** 合并决策落地：事务内完成 UPDATE/SUPERSEDE/ADD，随后异步补算向量。 */
  private async applyCandidates(
    candidates: MemoryCandidate[],
    session: Session,
    runId: string,
    provider: ProviderRuntimeConfig,
  ): Promise<Memory[]> {
    const memories = this.store.memories.list({})
    const similarities = findSimilarExisting(
      memories,
      candidates,
      (candidate) => (memory) => {
        const scope = this.resolveScope(candidate, session)
        return memory.scope === scope.scope && memory.scopeId === scope.scopeId
      },
    )
    let decisions
    try {
      decisions = await decideMerges(similarities, provider)
    } catch (error) {
      // 决策调用失败：无相似记忆的候选保守新增，其余放弃，避免堆积重复项。
      process.stderr.write(
        `[runtime] memory merge failed, falling back to ADD-only: ${String(error)}\n`,
      )
      decisions = similarities
        .filter((entry) => entry.similar.length === 0)
        .map((entry: CandidateSimilarity) => ({
          index: entry.index,
          action: 'ADD' as const,
          targetId: null,
          content: null,
        }))
    }

    const written: Memory[] = []
    this.store.transaction(() => {
      for (const decision of decisions) {
        const candidate = candidates[decision.index]
        if (!candidate || decision.action === 'NOOP') continue
        if (
          (decision.action === 'UPDATE' || decision.action === 'SUPERSEDE') &&
          decision.targetId !== null
        ) {
          const updated = this.store.memories.update(decision.targetId, {
            content: decision.content ?? candidate.content,
          })
          if (updated) written.push(updated)
          if (decision.action === 'UPDATE') continue
        }
        const scope = this.resolveScope(candidate, session)
        written.push(
          this.store.memories.create({
            scope: scope.scope,
            scopeId: scope.scopeId,
            kind: candidate.kind,
            content: decision.content ?? candidate.content,
            sourceRunId: runId,
            confidence: candidate.confidence,
          }),
        )
      }
    })
    void this.backfillEmbeddings(written)
    return written
  }

  /** project 候选在没有项目的会话中降级为 session 级（不丢信息，归属更保守）。 */
  private resolveScope(
    candidate: MemoryCandidate,
    session: Session,
  ): { scope: 'session' | 'project'; scopeId: string | null } {
    if (candidate.scope === 'project' && session.projectId !== null) {
      return { scope: 'project', scopeId: session.projectId }
    }
    return { scope: 'session', scopeId: session.id }
  }

  /** 批量补算向量；无 embedding Provider 或调用失败时静默跳过（召回自动降级）。 */
  private async backfillEmbeddings(memories: Memory[]): Promise<void> {
    if (memories.length === 0) return
    const embedding = resolveEmbeddingProvider(this.store)
    if (!embedding) return
    try {
      const vectors = await embedTexts({
        baseUrl: embedding.baseUrl,
        apiKey: embedding.apiKey,
        model: embedding.model,
        inputs: memories.map((memory) => memory.content),
      })
      vectors.forEach((vector, index) => {
        const memory = memories[index]
        if (memory && vector.length > 0) {
          this.store.memories.setEmbedding(memory.id, vector, embedding.model)
        }
      })
    } catch (error) {
      process.stderr.write(
        `[runtime] memory embedding backfill failed: ${String(error)}\n`,
      )
    }
  }
}
