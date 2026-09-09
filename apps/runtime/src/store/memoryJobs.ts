import type { DatabaseSync } from 'node:sqlite'
import { nowIso, type Row } from './shared.js'

/** Memory 提取任务状态：pending → running → completed / failed。 */
export type MemoryJobStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface MemoryJobRow {
  runId: string
  status: MemoryJobStatus
  attempts: number
  nextAttemptAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

/** 可重试退避（毫秒）：5s → 30s → 5min；耗尽后 failed。 */
export const MEMORY_JOB_BACKOFF_MS = [5_000, 30_000, 300_000]
export const MEMORY_JOB_MAX_ATTEMPTS = 3

export class MemoryJobStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 成功 Run 终态幂等入队（ON CONFLICT DO NOTHING）。 */
  enqueue(runId: string): void {
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO memory_jobs (run_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
         VALUES (?, 'pending', 0, NULL, NULL, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`,
      )
      .run(runId, now, now)
  }

  get(runId: string): MemoryJobRow | null {
    const row = this.db
      .prepare('SELECT * FROM memory_jobs WHERE run_id = ?')
      .get(runId) as Row | undefined
    return row ? this.toRow(row) : null
  }

  /** 待消费任务：pending 且（无退避时间或已到期），FIFO。 */
  claimNext(): MemoryJobRow | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_jobs
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .all(nowIso()) as Row[]
    if (rows.length === 0) return null
    const claimed = this.toRow(rows[0])
    const now = nowIso()
    this.db
      .prepare(
        "UPDATE memory_jobs SET status = 'running', updated_at = ? WHERE run_id = ? AND status = 'pending'",
      )
      .run(now, claimed.runId)
    return { ...claimed, status: 'running' }
  }

  markCompleted(runId: string): void {
    this.db
      .prepare(
        "UPDATE memory_jobs SET status = 'completed', updated_at = ? WHERE run_id = ?",
      )
      .run(nowIso(), runId)
  }

  /** 可恢复失败：attempts+1 并按退避放回 pending；超过上限置 failed。 */
  markRetryableFailure(runId: string, error: string): 'pending' | 'failed' {
    const job = this.get(runId)
    if (job === null) return 'failed'
    const attempts = job.attempts + 1
    const now = nowIso()
    if (attempts >= MEMORY_JOB_MAX_ATTEMPTS) {
      this.db
        .prepare(
          "UPDATE memory_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE run_id = ?",
        )
        .run(attempts, sanitizeError(error), now, runId)
      return 'failed'
    }
    const backoff =
      MEMORY_JOB_BACKOFF_MS[
        Math.min(attempts - 1, MEMORY_JOB_BACKOFF_MS.length - 1)
      ]
    this.db
      .prepare(
        "UPDATE memory_jobs SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE run_id = ?",
      )
      .run(
        attempts,
        new Date(Date.now() + backoff).toISOString(),
        sanitizeError(error),
        now,
        runId,
      )
    return 'pending'
  }

  /** 不可恢复失败（配置缺失/认证失败/transcript 不合法）：直接 failed。 */
  markPermanentFailure(runId: string, error: string): void {
    this.db
      .prepare(
        "UPDATE memory_jobs SET status = 'failed', updated_at = ?, last_error = ? WHERE run_id = ?",
      )
      .run(nowIso(), sanitizeError(error), runId)
  }

  /** 启动恢复：遗留 running 任务放回 pending（上次进程中断）。 */
  recoverRunning(): void {
    this.db
      .prepare(
        "UPDATE memory_jobs SET status = 'pending', next_attempt_at = NULL, updated_at = ? WHERE status = 'running'",
      )
      .run(nowIso())
  }

  private toRow(row: Row): MemoryJobRow {
    return {
      runId: String(row.run_id),
      status: String(row.status) as MemoryJobStatus,
      attempts: Number(row.attempts),
      nextAttemptAt:
        row.next_attempt_at == null ? null : String(row.next_attempt_at),
      lastError: row.last_error == null ? null : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}

/** last_error 只存安全摘要：长度截断（secret 过滤由调用方先行）。 */
function sanitizeError(error: string): string {
  return error.slice(0, 300)
}
