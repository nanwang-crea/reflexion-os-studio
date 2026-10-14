import type { DatabaseSync } from 'node:sqlite'
import {
  WorkflowGenerationSchema,
  type WorkflowGeneration,
} from '@reflexion-os-studio/contracts'

export class WorkflowGenerationStore {
  constructor(private readonly db: DatabaseSync) {}
  list(projectId: string, draftId: string): WorkflowGeneration[] {
    return this.db
      .prepare(
        'SELECT document_json FROM workflow_generations WHERE project_id = ? AND draft_id = ? ORDER BY rowid DESC LIMIT 10',
      )
      .all(projectId, draftId)
      .map((row) =>
        WorkflowGenerationSchema.parse(JSON.parse(String(row.document_json))),
      )
  }
  get(projectId: string, id: string): WorkflowGeneration | null {
    const row = this.db
      .prepare(
        'SELECT document_json FROM workflow_generations WHERE id = ? AND project_id = ?',
      )
      .get(id, projectId)
    return row
      ? WorkflowGenerationSchema.parse(JSON.parse(String(row.document_json)))
      : null
  }
  hasActiveProject(projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT id FROM workflow_generations WHERE project_id = ? AND status = 'running' LIMIT 1",
        )
        .get(projectId),
    )
  }
  bySession(sessionId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT id FROM workflow_generations WHERE session_id = ?')
        .get(sessionId),
    )
  }
  create(generation: WorkflowGeneration): void {
    const value = WorkflowGenerationSchema.parse(generation)
    this.db
      .prepare(
        'INSERT INTO workflow_generations (id, project_id, draft_id, session_id, status, document_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        value.id,
        value.projectId,
        value.draftId,
        value.sessionId,
        value.status,
        JSON.stringify(value),
      )
  }
  update(generation: WorkflowGeneration): void {
    const value = WorkflowGenerationSchema.parse(generation)
    const old = this.get(value.projectId, value.id)
    if (
      !old ||
      (old.status !== 'running' &&
        !(old.status === 'ready' && value.status === 'applied') &&
        !(
          ['ready', 'invalid'].includes(old.status) &&
          ['ready', 'invalid'].includes(value.status)
        )) ||
      old.stateVersion !== value.stateVersion ||
      old.draftId !== value.draftId ||
      old.baseRevision !== value.baseRevision ||
      value.tokensUsed < old.tokensUsed
    )
      throw new Error('workflow_generation_state_conflict')
    this.db
      .prepare(
        'UPDATE workflow_generations SET status = ?, session_id = ?, document_json = ? WHERE id = ? AND status = ?',
      )
      .run(
        value.status,
        value.sessionId,
        JSON.stringify({ ...value, stateVersion: value.stateVersion + 1 }),
        value.id,
        old.status,
      )
  }
  recover(): void {
    for (const row of this.db
      .prepare(
        "SELECT document_json FROM workflow_generations WHERE status = 'running'",
      )
      .all()) {
      const value = WorkflowGenerationSchema.parse(
        JSON.parse(String(row.document_json)),
      )
      this.update({
        ...value,
        status: 'interrupted',
        errorCode: 'generation_interrupted',
        tokensUsed: value.tokensUsed + 32000,
        tokensEstimated: true,
        updatedAt: new Date().toISOString(),
      })
    }
  }
}
