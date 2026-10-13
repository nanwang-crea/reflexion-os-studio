import type { DatabaseSync } from 'node:sqlite'
import {
  WorkflowPublishedOutputSchema,
  type WorkflowPublishedOutput,
} from '@reflexion-os-studio/contracts'

export class WorkflowOutputStore {
  constructor(private readonly db: DatabaseSync) {}
  publish(value: WorkflowPublishedOutput): void {
    const item = WorkflowPublishedOutputSchema.parse(value)
    this.db
      .prepare(
        `INSERT INTO workflow_outputs
      (attempt_id, workflow_run_id, node_id, document_json) VALUES (?, ?, ?, ?)`,
      )
      .run(
        item.attemptId,
        item.workflowRunId,
        item.nodeId,
        JSON.stringify(item),
      )
  }
  list(runId: string): WorkflowPublishedOutput[] {
    return this.db
      .prepare(
        `SELECT document_json FROM workflow_outputs WHERE workflow_run_id = ? ORDER BY rowid`,
      )
      .all(runId)
      .map((row) =>
        WorkflowPublishedOutputSchema.parse(
          JSON.parse(String(row.document_json)),
        ),
      )
  }
}
