import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Run, RunStatus } from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/** Run 领域：一次回复的执行生命周期。 */
export class RunStore {
  constructor(private readonly db: DatabaseSync) {}

  listBySession(sessionId: string): Run[] {
    // 理由同 messages：同毫秒 Run 依赖随机 UUID 排序不稳定，rowid 即插入顺序。
    return this.db
      .prepare(
        'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at ASC, rowid ASC',
      )
      .all(sessionId)
      .map((row) => this.toRun(row as Row))
  }

  create(input: {
    sessionId: string
    providerId: string | null
    model: string | null
    retryOfRunId?: string | null
  }): Run {
    const run: Run = {
      id: randomUUID(),
      sessionId: input.sessionId,
      status: 'running',
      providerId: input.providerId,
      model: input.model,
      startedAt: nowIso(),
      completedAt: null,
      errorCode: null,
      retryOfRunId: input.retryOfRunId ?? null,
    }
    this.db
      .prepare(
        'INSERT INTO runs (id, session_id, status, provider_id, model, started_at, completed_at, error_code, retry_of_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        run.id,
        run.sessionId,
        run.status,
        run.providerId,
        run.model,
        run.startedAt,
        run.completedAt,
        run.errorCode,
        run.retryOfRunId,
      )
    return run
  }

  get(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    return row ? this.toRun(row as Row) : null
  }

  finalize(id: string, status: RunStatus, errorCode?: string): void {
    this.db
      .prepare(
        'UPDATE runs SET status = ?, completed_at = ?, error_code = ? WHERE id = ?',
      )
      .run(status, nowIso(), errorCode ?? null, id)
  }

  activeForSession(sessionId: string): Run | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE session_id = ? AND status IN ('created', 'running') LIMIT 1",
      )
      .get(sessionId)
    return row ? this.toRun(row as Row) : null
  }

  /** 启动恢复：未结束的 Run 标记为 interrupted。 */
  recoverInterrupted(): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', completed_at = ?
         WHERE status IN ('created', 'running')`,
      )
      .run(nowIso())
  }

  private toRun(row: Row): Run {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      status: String(row.status) as RunStatus,
      providerId: row.provider_id == null ? null : String(row.provider_id),
      model: row.model == null ? null : String(row.model),
      startedAt: row.started_at == null ? null : String(row.started_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      errorCode: row.error_code == null ? null : String(row.error_code),
      retryOfRunId:
        row.retry_of_run_id == null ? null : String(row.retry_of_run_id),
    }
  }
}
