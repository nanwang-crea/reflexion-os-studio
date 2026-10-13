import type { DatabaseSync } from 'node:sqlite'
import {
  WorkflowAttemptSchema,
  WorkflowAttemptResultSchema,
  canTransitionWorkflowAttempt,
  type WorkflowAttempt,
  type WorkflowAttemptResult,
} from '@reflexion-os-studio/contracts'

export class WorkflowAttemptStore {
  constructor(private readonly db: DatabaseSync) {}
  create(value: WorkflowAttempt): WorkflowAttempt {
    const item = WorkflowAttemptSchema.parse(value)
    this.db
      .prepare(
        `INSERT INTO workflow_node_attempts
      (id, workflow_run_id, node_id, attempt_no, status, agent_run_id, session_id, document_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.workflowRunId,
        item.nodeId,
        item.attemptNo,
        item.status,
        item.agentRunId,
        item.sessionId,
        JSON.stringify(item),
      )
    return item
  }
  get(id: string): WorkflowAttempt | null {
    const row = this.db
      .prepare('SELECT document_json FROM workflow_node_attempts WHERE id = ?')
      .get(id)
    return row
      ? WorkflowAttemptSchema.parse(JSON.parse(String(row.document_json)))
      : null
  }
  list(workflowRunId: string): WorkflowAttempt[] {
    return this.db
      .prepare(
        `SELECT document_json FROM workflow_node_attempts
      WHERE workflow_run_id = ? ORDER BY rowid`,
      )
      .all(workflowRunId)
      .map((row) =>
        WorkflowAttemptSchema.parse(JSON.parse(String(row.document_json))),
      )
  }
  byAgentRun(id: string): WorkflowAttempt | null {
    const row = this.db
      .prepare('SELECT id FROM workflow_node_attempts WHERE agent_run_id = ?')
      .get(id)
    return row ? this.get(String(row.id)) : null
  }
  bySession(id: string): WorkflowAttempt | null {
    const row = this.db
      .prepare('SELECT id FROM workflow_node_attempts WHERE session_id = ?')
      .get(id)
    return row ? this.get(String(row.id)) : null
  }
  update(value: WorkflowAttempt): void {
    const parsed = WorkflowAttemptSchema.parse(value)
    const current = this.get(value.id)
    if (
      !current ||
      ['succeeded', 'failed', 'rejected', 'cancelled', 'interrupted'].includes(
        current.status,
      )
    )
      throw new Error('Attempt is already terminal')
    if (
      current.status !== parsed.status &&
      !canTransitionWorkflowAttempt(current.status, parsed.status)
    )
      throw new Error('Invalid attempt transition')
    if (
      current.workflowRunId !== parsed.workflowRunId ||
      current.nodeId !== parsed.nodeId ||
      current.inputHash !== parsed.inputHash ||
      { none: 0, possible: 1, recorded: 2 }[parsed.effectStatus] <
        { none: 0, possible: 1, recorded: 2 }[current.effectStatus] ||
      current.tokenBudget !== parsed.tokenBudget
    )
      throw new Error('Attempt snapshot is immutable')
    this.db
      .prepare(
        `UPDATE workflow_node_attempts SET status = ?, agent_run_id = ?, session_id = ?, document_json = ?
      WHERE id = ?`,
      )
      .run(
        parsed.status,
        parsed.agentRunId,
        parsed.sessionId,
        JSON.stringify(parsed),
        parsed.id,
      )
  }
  markPossibleEffect(id: string): void {
    const value = this.get(id)
    if (value && value.status === 'running' && value.effectStatus === 'none')
      this.update({ ...value, effectStatus: 'possible' })
  }
  stageResult(value: WorkflowAttemptResult): void {
    const item = WorkflowAttemptResultSchema.parse(value)
    this.db
      .prepare(
        'INSERT INTO workflow_attempt_results (attempt_id, document_json) VALUES (?, ?)',
      )
      .run(item.attemptId, JSON.stringify(item))
  }
  result(id: string): WorkflowAttemptResult | null {
    const row = this.db
      .prepare(
        'SELECT document_json FROM workflow_attempt_results WHERE attempt_id = ?',
      )
      .get(id)
    return row
      ? WorkflowAttemptResultSchema.parse(JSON.parse(String(row.document_json)))
      : null
  }
  restoreCompleted(value: WorkflowAttempt): void {
    const item = WorkflowAttemptSchema.parse(value)
    const current = this.get(item.id)
    const run = this.db
      .prepare('SELECT status FROM runs WHERE id = ?')
      .get(item.agentRunId ?? '')
    if (
      current?.status !== 'interrupted' ||
      item.status !== 'succeeded' ||
      current.agentRunId !== item.agentRunId ||
      current.sessionId !== item.sessionId ||
      current.nodeId !== item.nodeId ||
      current.workflowRunId !== item.workflowRunId ||
      current.inputHash !== item.inputHash ||
      current.tokenBudget !== item.tokenBudget ||
      run?.status !== 'completed' ||
      !this.result(item.id)?.values
    )
      throw new Error('Completed checkpoint is unavailable')
    this.db
      .prepare(
        'UPDATE workflow_node_attempts SET status = ?, document_json = ? WHERE id = ?',
      )
      .run(item.status, JSON.stringify(item), item.id)
  }
}
