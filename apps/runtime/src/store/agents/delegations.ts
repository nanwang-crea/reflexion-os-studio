import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AgentInstance,
  Delegation,
  DelegationResult,
  DelegationStatus,
} from '@reflexion-os-studio/contracts'
import {
  AgentInstanceSchema,
  DelegationExecutionSchema,
  DelegationResultSchema,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from '../shared.js'
import { buildDelegationResult } from './delegationResults.js'

function parseExecution(value: unknown): Delegation['execution'] {
  if (value == null) return null
  try {
    const parsed = DelegationExecutionSchema.safeParse(
      JSON.parse(String(value)),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function parseInstance(value: unknown): AgentInstance | null {
  if (value == null) return null
  try {
    const parsed = AgentInstanceSchema.safeParse(JSON.parse(String(value)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function parseResult(value: unknown): Delegation['structuredResult'] {
  if (value == null) return null
  try {
    const parsed = DelegationResultSchema.safeParse(JSON.parse(String(value)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export class DelegationStore {
  constructor(private readonly db: DatabaseSync) {}

  create(
    input: Pick<Delegation, 'sessionId' | 'parentRunId' | 'agentId' | 'task'> &
      Partial<
        Pick<
          Delegation,
          | 'rootRunId'
          | 'parentAgentId'
          | 'childSessionId'
          | 'execution'
          | 'agentInstance'
        >
      >,
  ): Delegation {
    const now = nowIso()
    const delegation: Delegation = {
      id: randomUUID(),
      sessionId: input.sessionId,
      parentRunId: input.parentRunId,
      rootRunId: input.rootRunId ?? input.parentRunId,
      parentAgentId: input.parentAgentId ?? null,
      agentId: input.agentId,
      agentInstance: input.agentInstance ?? null,
      task: input.task,
      status: 'pending',
      childSessionId: input.childSessionId ?? null,
      childRunId: null,
      execution: input.execution ?? null,
      result: null,
      structuredResult: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO delegations (
          id, session_id, parent_run_id, root_run_id, parent_agent_id, agent_id,
          task, status, child_run_id, child_session_id, execution_json,
          instance_json, result, result_json, error, created_at, updated_at,
          completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        delegation.id,
        input.sessionId,
        input.parentRunId,
        delegation.rootRunId,
        delegation.parentAgentId,
        input.agentId,
        input.task,
        delegation.status,
        null,
        delegation.childSessionId,
        delegation.execution === null
          ? null
          : JSON.stringify(delegation.execution),
        delegation.agentInstance === null
          ? null
          : JSON.stringify(delegation.agentInstance),
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

  listByRootRun(rootRunId: string): Delegation[] {
    return this.db
      .prepare(
        'SELECT * FROM delegations WHERE root_run_id = ? ORDER BY created_at, rowid',
      )
      .all(rootRunId)
      .map((row) => this.toDelegation(row as Row))
  }

  buildStructuredResult(childRunId: string, summary: string): DelegationResult {
    return buildDelegationResult(this.db, childRunId, summary)
  }

  getByChildRun(childRunId: string): Delegation | null {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE child_run_id = ?')
      .get(childRunId) as Row | undefined
    return row ? this.toDelegation(row) : null
  }

  /** 启动恢复：以 child Run canonical 终态收敛可能漏写的委派终态。 */
  recoverInterrupted(): void {
    const rows = this.db
      .prepare(
        `SELECT d.*, r.status AS child_status, r.error_code AS child_error_code
         FROM delegations d
         LEFT JOIN runs r ON r.id = d.child_run_id
         WHERE d.status IN ('pending', 'running')`,
      )
      .all() as Row[]
    for (const row of rows) {
      const id = String(row.id)
      const childRunId =
        row.child_run_id == null || row.child_run_id === ''
          ? null
          : String(row.child_run_id)
      if (childRunId === null || row.child_status == null) {
        this.update(id, 'failed', null, 'recovered: child run missing')
        continue
      }
      const childStatus = String(row.child_status)
      if (childStatus === 'completed') {
        const message = this.db
          .prepare(
            `SELECT content FROM messages
             WHERE run_id = ? AND role = 'assistant' AND status = 'completed'
             ORDER BY rowid DESC LIMIT 1`,
          )
          .get(childRunId) as { content: string } | undefined
        const summary = message?.content ?? ''
        this.update(
          id,
          'completed',
          summary,
          null,
          this.buildStructuredResult(childRunId, summary),
        )
      } else if (childStatus === 'cancelled') {
        this.update(id, 'cancelled', null, 'recovered: child run cancelled')
      } else {
        const code =
          row.child_error_code == null
            ? childStatus
            : String(row.child_error_code)
        this.update(id, 'failed', null, `recovered: child run ${code}`)
      }
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
    structuredResult?: DelegationResult | null,
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
        'UPDATE delegations SET status = ?, result = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      )
      .run(
        status,
        result ?? current.result,
        structuredResult === undefined
          ? current.structuredResult === null
            ? null
            : JSON.stringify(current.structuredResult)
          : structuredResult === null
            ? null
            : JSON.stringify(structuredResult),
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
      rootRunId: row.root_run_id == null ? null : String(row.root_run_id),
      parentAgentId:
        row.parent_agent_id == null ? null : String(row.parent_agent_id),
      agentId: String(row.agent_id),
      agentInstance: parseInstance(row.instance_json),
      task: String(row.task),
      status: String(row.status) as DelegationStatus,
      childRunId: row.child_run_id == null ? null : String(row.child_run_id),
      childSessionId:
        row.child_session_id == null ? null : String(row.child_session_id),
      execution: parseExecution(row.execution_json),
      result: row.result == null ? null : String(row.result),
      structuredResult: parseResult(row.result_json),
      error: row.error == null ? null : String(row.error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    }
  }
}
