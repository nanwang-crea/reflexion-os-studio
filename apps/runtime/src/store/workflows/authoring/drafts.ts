import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  WorkflowDraftSchema,
  type WorkflowDraft,
  type WorkflowCommandParams,
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
  save(input: WorkflowCommandParams<'workflow.draft.save'>): WorkflowDraft {
    const old = input.draftId ? this.get(input.projectId, input.draftId) : null
    if (
      input.draftId
        ? !old || old.revision !== input.baseRevision
        : input.baseRevision !== 0
    )
      throw new Error('workflow_draft_conflict')
    const draft = WorkflowDraftSchema.parse({
      id: input.draftId ?? randomUUID(),
      projectId: input.projectId,
      revision: input.baseRevision + 1,
      definitionId: input.definitionId,
      baseVersion: input.baseVersion,
      definition: input.definition,
      generationId: old?.generationId ?? null,
      updatedAt: new Date().toISOString(),
    })
    this.write(draft, old?.revision)
    return draft
  }
  write(draft: WorkflowDraft, baseRevision?: number): void {
    const parsed = WorkflowDraftSchema.parse(draft)
    if (baseRevision === undefined)
      this.db
        .prepare(
          'INSERT INTO workflow_drafts (id, project_id, revision, document_json) VALUES (?, ?, ?, ?)',
        )
        .run(
          parsed.id,
          parsed.projectId,
          parsed.revision,
          JSON.stringify(parsed),
        )
    else {
      const result = this.db
        .prepare(
          'UPDATE workflow_drafts SET revision = ?, document_json = ? WHERE id = ? AND project_id = ? AND revision = ?',
        )
        .run(
          parsed.revision,
          JSON.stringify(parsed),
          parsed.id,
          parsed.projectId,
          baseRevision,
        )
      if (!result.changes) throw new Error('workflow_draft_conflict')
    }
  }
}
