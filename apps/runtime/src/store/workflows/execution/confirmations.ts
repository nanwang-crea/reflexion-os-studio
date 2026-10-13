import type { DatabaseSync } from 'node:sqlite'
import {
  WorkflowConfirmationSchema,
  type WorkflowConfirmation,
} from '@reflexion-os-studio/contracts'

export class WorkflowConfirmationStore {
  constructor(private readonly db: DatabaseSync) {}
  create(value: WorkflowConfirmation): void {
    const item = WorkflowConfirmationSchema.parse(value)
    this.db
      .prepare(
        `INSERT INTO workflow_confirmations
      (id, workflow_run_id, attempt_id, status, document_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.workflowRunId,
        item.attemptId,
        item.status,
        JSON.stringify(item),
      )
  }
  get(id: string): WorkflowConfirmation | null {
    const row = this.db
      .prepare('SELECT document_json FROM workflow_confirmations WHERE id = ?')
      .get(id)
    return row
      ? WorkflowConfirmationSchema.parse(JSON.parse(String(row.document_json)))
      : null
  }
  list(runId: string): WorkflowConfirmation[] {
    return this.db
      .prepare(
        `SELECT document_json FROM workflow_confirmations WHERE workflow_run_id = ? ORDER BY rowid`,
      )
      .all(runId)
      .map((row) =>
        WorkflowConfirmationSchema.parse(JSON.parse(String(row.document_json))),
      )
  }
  resolve(
    id: string,
    status: Exclude<WorkflowConfirmation['status'], 'pending'>,
  ): void {
    const value = this.get(id)
    if (!value || value.status !== 'pending')
      throw new Error('Confirmation is not pending')
    this.db
      .prepare(
        `UPDATE workflow_confirmations SET status = ?, document_json = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(status, JSON.stringify({ ...value, status }), id)
  }
}
