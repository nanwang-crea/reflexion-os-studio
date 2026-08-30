import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  type Memory,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/** 召回候选：协议 Memory + 内部使用的向量（不进协议）。 */
export interface MemoryRecallCandidate {
  memory: Memory
  vector: number[] | null
  vectorModel: string | null
}

/** 向量以 Float32 小端 BLOB 落盘；数千条桌面级规模下足够紧凑。 */
function encodeVector(vector: number[]): Uint8Array {
  const f32 = new Float32Array(vector)
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
}

function decodeVector(data: Uint8Array): number[] {
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  )
  return Array.from(new Float32Array(buffer))
}

/**
 * 记忆领域（A2 mem0 式管线）：提取候选落库、合并更新、管理页 CRUD 与
 * FTS 召回。向量与 FTS 索引属于存储内部表示，不进协议。
 */
export class MemoryStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    scope: MemoryScope
    scopeId: string | null
    kind: MemoryKind
    content: string
    sourceRunId?: string | null
    confidence?: number
    status?: MemoryStatus
  }): Memory {
    const memory: Memory = {
      id: randomUUID(),
      scope: input.scope,
      scopeId: input.scopeId,
      kind: input.kind,
      content: input.content,
      sourceRunId: input.sourceRunId ?? null,
      confidence: input.confidence ?? 0.8,
      status: input.status ?? 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: null,
    }
    this.db
      .prepare(
        'INSERT INTO memories (id, scope, scope_id, kind, content, source_run_id, confidence, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        memory.id,
        memory.scope,
        memory.scopeId,
        memory.kind,
        memory.content,
        memory.sourceRunId,
        memory.confidence,
        memory.status,
        memory.createdAt,
        memory.updatedAt,
        memory.expiresAt,
      )
    return memory
  }

  get(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    return row ? this.toMemory(row as Row) : null
  }

  /** 管理页列表：不含 archived（被取代的历史版本）。pinned 置顶。 */
  list(filter: { scope?: MemoryScope; scopeId?: string | null }): Memory[] {
    const conditions = [`status <> 'archived'`]
    const args: (string | null)[] = []
    if (filter.scope) {
      conditions.push('scope = ?')
      args.push(filter.scope)
    }
    if (filter.scopeId !== undefined) {
      conditions.push('scope_id IS ?')
      args.push(filter.scopeId)
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${conditions.join(' AND ')}
         ORDER BY CASE status WHEN 'pinned' THEN 0 ELSE 1 END, created_at DESC, rowid DESC`,
      )
      .all(...args)
    return rows.map((row) => this.toMemory(row as Row))
  }

  update(
    id: string,
    patch: { content?: string; status?: MemoryStatus },
  ): Memory | null {
    const existing = this.get(id)
    if (!existing) return null
    // 内容编辑使原向量失效：向量空间由模型决定，必须重算后才能参与余弦召回。
    if (patch.content !== undefined) {
      this.db
        .prepare(
          'UPDATE memories SET content = ?, embedding = NULL, embedding_model = NULL, updated_at = ? WHERE id = ?',
        )
        .run(patch.content, nowIso(), id)
    }
    if (patch.status !== undefined) {
      this.db
        .prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?')
        .run(patch.status, nowIso(), id)
    }
    return this.get(id)
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  /**
   * 按范围清理：scope_id 是多态引用（无外键级联），会话/项目被删除时
   * 由调用方在删除主体的事务里调用，避免留下永远不可再召回的孤儿记忆。
   */
  removeByScope(scope: MemoryScope, scopeId: string | null): void {
    this.db
      .prepare('DELETE FROM memories WHERE scope = ? AND scope_id IS ?')
      .run(scope, scopeId)
  }

  /** 落库后异步补算向量；失败时保持 NULL，召回自动退化为 FTS + recency。 */
  setEmbedding(id: string, vector: number[], model: string): void {
    this.db
      .prepare(
        'UPDATE memories SET embedding = ?, embedding_model = ? WHERE id = ?',
      )
      .run(encodeVector(vector), model, id)
  }

  /** 召回候选：active/pinned 且未过期的指定范围记忆（含向量）。 */
  listRecallCandidates(
    scopes: { scope: MemoryScope; scopeId: string | null }[],
  ): MemoryRecallCandidate[] {
    const candidates: MemoryRecallCandidate[] = []
    const statement = this.db.prepare(
      `SELECT * FROM memories
       WHERE scope = ? AND scope_id IS ? AND status IN ('active', 'pinned')
         AND (expires_at IS NULL OR expires_at > ?)`,
    )
    for (const { scope, scopeId } of scopes) {
      const rows = statement.all(scope, scopeId, nowIso())
      for (const row of rows as Row[]) {
        const data = row.embedding
        candidates.push({
          memory: this.toMemory(row),
          vector: data ? decodeVector(data as Uint8Array) : null,
          vectorModel:
            row.embedding_model == null ? null : String(row.embedding_model),
        })
      }
    }
    return candidates
  }

  /**
   * FTS 检索：优先 MATCH（≥3 字符的子串短语），失败/无命中退化为 LIKE 扫描
   * （桌面级数据量可接受）。rank 语义：MATCH 为 bm25（越小越相关）；
   * LIKE 命中无排名（null，仅作候选集，排序交给召回侧混合评分）。
   */
  searchFts(query: string, limit = 50): { id: string; rank: number | null }[] {
    const trimmed = query.trim()
    if (trimmed === '') return []
    if (trimmed.length >= 3) {
      const phrase = `"${trimmed.replace(/"/g, '""')}"`
      try {
        const rows = this.db
          .prepare(
            `SELECT m.id AS id, bm25(memories_fts) AS rank
             FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? AND m.status <> 'archived'
             ORDER BY rank LIMIT ?`,
          )
          .all(phrase, limit) as Row[]
        if (rows.length > 0) {
          return rows.map((row) => ({
            id: String(row.id),
            rank: Number(row.rank),
          }))
        }
      } catch {
        // MATCH 语法异常（奇怪输入）时退化为 LIKE，不让召回失败。
      }
    }
    const escaped = trimmed.replace(/[%_\\]/g, (c) => `\\${c}`)
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, NULL AS rank
         FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE f.content LIKE ? ESCAPE '\\' AND m.status <> 'archived'
         LIMIT ?`,
      )
      .all(`%${escaped}%`, limit) as Row[]
    return rows.map((row) => ({ id: String(row.id), rank: null }))
  }

  private toMemory(row: Row): Memory {
    return {
      id: String(row.id),
      scope: String(row.scope) as MemoryScope,
      scopeId: row.scope_id == null ? null : String(row.scope_id),
      kind: String(row.kind) as MemoryKind,
      content: String(row.content),
      sourceRunId: row.source_run_id == null ? null : String(row.source_run_id),
      confidence: Number(row.confidence),
      status: String(row.status) as MemoryStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      expiresAt: row.expires_at == null ? null : String(row.expires_at),
    }
  }
}
