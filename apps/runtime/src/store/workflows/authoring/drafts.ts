import type { DatabaseSync } from 'node:sqlite'
import {
  WorkflowDraftSchema,
  type WorkflowDraft,
} from '@reflexion-os-studio/contracts'

export class WorkflowDraftStore {
  constructor(private readonly db: DatabaseSync) {}
  get(projectId: string, id: string): WorkflowDraft | null {
    const row = this.db
      .prepare(
        'SELECT document_json FROM workflow_drafts WHERE id = ? AND project_id = ?',
      )
      .get(id, projectId)
    return row
      ? WorkflowDraftSchema.parse(JSON.parse(String(row.document_json)))
      : null
  }
  list(projectId: string): WorkflowDraft[] {
    return this.db
      .prepare(
        'SELECT document_json FROM workflow_drafts WHERE project_id = ? ORDER BY rowid DESC LIMIT 100',
      )
      .all(projectId)
      .map((row) =>
        WorkflowDraftSchema.parse(JSON.parse(String(row.document_json))),
      )
  }
}
