import type { DatabaseSync } from 'node:sqlite'
import { nowIso, type Row } from './shared.js'

/** Checkpoint 摘要结构（§6.1）；zod 校验在 checkpoint 服务层完成。 */
export interface ContextCheckpointSummary {
  goal: string | null
  constraints: string[]
  decisions: string[]
  completed: string[]
  pending: string[]
  toolFacts: string[]
  knownErrors: string[]
}

/** 单会话一份的结构化上下文缓存：来源变化时可删除重建（非 canonical 事实源）。 */
export interface ContextCheckpointRow {
  sessionId: string
  throughMessageId: string | null
  sourceHash: string
  summary: ContextCheckpointSummary
  tokenEstimate: number
  model: string
  schemaVersion: number
  createdAt: string
  updatedAt: string
}

export class ContextCheckpointStore {
  constructor(private readonly db: DatabaseSync) {}

  get(sessionId: string): ContextCheckpointRow | null {
    const row = this.db
      .prepare('SELECT * FROM context_checkpoints WHERE session_id = ?')
      .get(sessionId) as Row | undefined
    return row ? this.toRow(row) : null
  }

  upsert(input: {
    sessionId: string
    throughMessageId: string | null
    sourceHash: string
    summary: ContextCheckpointSummary
    tokenEstimate: number
    model: string
    schemaVersion: number
  }): ContextCheckpointRow {
    const now = nowIso()
    const existingCreatedAt = this.db
      .prepare(
        'SELECT created_at FROM context_checkpoints WHERE session_id = ?',
      )
      .get(input.sessionId) as { created_at?: unknown } | undefined
    const createdAt =
      typeof existingCreatedAt?.created_at === 'string'
        ? existingCreatedAt.created_at
        : now
    this.db
      .prepare(
        `INSERT INTO context_checkpoints
         (session_id, through_message_id, source_hash, summary_json, token_estimate, model, schema_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           through_message_id = excluded.through_message_id,
           source_hash = excluded.source_hash,
           summary_json = excluded.summary_json,
           token_estimate = excluded.token_estimate,
           model = excluded.model,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.sessionId,
        input.throughMessageId,
        input.sourceHash,
        JSON.stringify(input.summary),
        input.tokenEstimate,
        input.model,
        input.schemaVersion,
        createdAt,
        now,
      )
    return this.get(input.sessionId)!
  }

  delete(sessionId: string): void {
    this.db
      .prepare('DELETE FROM context_checkpoints WHERE session_id = ?')
      .run(sessionId)
  }

  private toRow(row: Row): ContextCheckpointRow {
    let summary: ContextCheckpointSummary
    try {
      summary = JSON.parse(String(row.summary_json)) as ContextCheckpointSummary
    } catch {
      summary = emptySummary()
    }
    return {
      sessionId: String(row.session_id),
      throughMessageId:
        row.through_message_id == null ? null : String(row.through_message_id),
      sourceHash: String(row.source_hash),
      summary,
      tokenEstimate: Number(row.token_estimate),
      model: String(row.model),
      schemaVersion: Number(row.schema_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}

export function emptySummary(): ContextCheckpointSummary {
  return {
    goal: null,
    constraints: [],
    decisions: [],
    completed: [],
    pending: [],
    toolFacts: [],
    knownErrors: [],
  }
}
