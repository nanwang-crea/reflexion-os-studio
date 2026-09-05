import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Delegation,
  DelegationStatus,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

export class DelegationStore {
  constructor(private readonly db: DatabaseSync) {}

  create(
    input: Pick<Delegation, 'sessionId' | 'parentRunId' | 'agentId' | 'task'>,
  ): Delegation {
    const now = nowIso()
    const delegation: Delegation = {
      id: randomUUID(),
      ...input,
      status: 'pending',
      childRunId: null,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO delegations (id, session_id, parent_run_id, agent_id, task, status, child_run_id, result, error, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        delegation.id,
        input.sessionId,
        input.parentRunId,
        input.agentId,
        input.task,
        delegation.status,
        null,
        null,
        null,
        now,
        now,
        null,
      )
    return delegation
  }

  get(id: string): Delegation | null {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE id = ?')
      .get(id) as Row | undefined
    return row ? this.toDelegation(row) : null
  }

  listBySession(sessionId: string): Delegation[] {
    return this.db
      .prepare(
        'SELECT * FROM delegations WHERE session_id = ? ORDER BY created_at, rowid',
      )
      .all(sessionId)
      .map((row) => this.toDelegation(row as Row))
  }

  listByParentRun(parentRunId: string): Delegation[] {
    return this.db
      .prepare(
        'SELECT * FROM delegations WHERE parent_run_id = ? ORDER BY created_at, rowid',
      )
      .all(parentRunId)
      .map((row) => this.toDelegation(row as Row))
  }

  getByChildRun(childRunId: string): Delegation | null {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE child_run_id = ?')
      .get(childRunId) as Row | undefined
    return row ? this.toDelegation(row) : null
  }

  /** 启动恢复：无法继续执行的子任务统一收敛为可解释的失败。 */
  recoverInterrupted(): void {
    const rows = this.db
      .prepare(
        `SELECT d.* FROM delegations d
         LEFT JOIN runs r ON r.id = d.child_run_id
         WHERE d.status IN ('pending', 'running')
           AND (d.child_run_id IS NULL OR r.id IS NULL OR r.status = 'interrupted')`,
      )
      .all() as Row[]
    const now = nowIso()
    const statement = this.db.prepare(
      `UPDATE delegations SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status IN ('pending', 'running')`,
    )
    for (const row of rows) {
      const reason =
        row.child_run_id == null || row.child_run_id === ''
          ? 'recovered: child run missing'
          : 'recovered: child run interrupted'
      statement.run(reason, now, now, String(row.id))
    }
  }

  /** 按父 Run 取消所有未结束委派；重复调用保持幂等。 */
  cancelByParentRun(parentRunId: string): Delegation[] {
    const now = nowIso()
    this.db
      .prepare(
        `UPDATE delegations SET status = 'cancelled', updated_at = ?, completed_at = ?
         WHERE parent_run_id = ? AND status IN ('pending', 'running')`,
      )
      .run(now, now, parentRunId)
    return this.listByParentRun(parentRunId)
  }

  attachChildRun(id: string, childRunId: string): Delegation {
    const current = this.get(id)
    if (!current) throw new Error('delegation not found')
    if (current.childRunId === childRunId) return current
    if (current.childRunId != null)
      throw new Error('delegation child run already attached')
    this.db
      .prepare(
        'UPDATE delegations SET child_run_id = ?, updated_at = ? WHERE id = ? AND child_run_id IS NULL',
      )
      .run(childRunId, nowIso(), id)
    return this.get(id)!
  }

  update(
    id: string,
    status: DelegationStatus,
    result?: string | null,
    error?: string | null,
  ): Delegation {
    const current = this.get(id)
    if (!current) throw new Error('delegation not found')
    const now = nowIso()
    const terminal = ['completed', 'failed', 'cancelled'].includes(status)
    // 状态推进幂等：重复投递相同终态（包括结果/错误）不改时间戳；终态不可被回退。
    if (
      current.status === status &&
      (result === undefined || result === current.result) &&
      (error === undefined || error === current.error)
    )
      return current
    if (['completed', 'failed', 'cancelled'].includes(current.status))
      return current
    this.db
      .prepare(
        'UPDATE delegations SET status = ?, result = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      )
      .run(
        status,
        result ?? current.result,
        error ?? current.error,
        now,
        terminal ? now : current.completedAt,
        id,
      )
    return this.get(id)!
  }

  private toDelegation(row: Row): Delegation {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      parentRunId: String(row.parent_run_id),
      agentId: String(row.agent_id),
      task: String(row.task),
      status: String(row.status) as DelegationStatus,
      childRunId: row.child_run_id == null ? null : String(row.child_run_id),
      result: row.result == null ? null : String(row.result),
      error: row.error == null ? null : String(row.error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    }
  }
}
