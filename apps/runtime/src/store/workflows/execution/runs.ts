import type { DatabaseSync } from 'node:sqlite'
import {
  WorkflowRunSchema,
  canTransitionWorkflowRun,
  type WorkflowRun,
} from '@reflexion-os-studio/contracts'

export class WorkflowStateConflict extends Error {
  readonly code = 'workflow_state_conflict'
  constructor() {
    super('Workflow state changed; reload before acting')
  }
}
export class WorkflowRunStore {
  constructor(private readonly db: DatabaseSync) {}

  create(run: WorkflowRun): WorkflowRun {
    const value = WorkflowRunSchema.parse(run)
    this.db
      .prepare(
        `INSERT INTO workflow_runs
      (id, project_id, definition_id, definition_revision, request_id, status, state_version, document_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.projectId,
        value.snapshot.definitionId,
        value.snapshot.revision,
        value.requestId,
        value.status,
        value.stateVersion,
        JSON.stringify(value),
      )
    return value
  }
  get(id: string): WorkflowRun | null {
    const row = this.db
      .prepare('SELECT document_json FROM workflow_runs WHERE id = ?')
      .get(id)
    return row
      ? WorkflowRunSchema.parse(JSON.parse(String(row.document_json)))
      : null
  }
  byRequest(requestId: string): WorkflowRun | null {
    const row = this.db
      .prepare('SELECT id FROM workflow_runs WHERE request_id = ?')
      .get(requestId)
    return row ? this.get(String(row.id)) : null
  }
  list(projectId?: string, limit = 30, offset = 0): WorkflowRun[] {
    return this.db
      .prepare(
        `SELECT document_json FROM workflow_runs
      WHERE (? IS NULL OR project_id = ?) ORDER BY rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(projectId ?? null, projectId ?? null, limit, offset)
      .map((row) =>
        WorkflowRunSchema.parse(JSON.parse(String(row.document_json))),
      )
  }
  active(): WorkflowRun[] {
    return this.db
      .prepare(
        `SELECT document_json FROM workflow_runs
      WHERE status IN ('pending', 'running', 'waiting_user', 'cancelling')`,
      )
      .all()
      .map((row) =>
        WorkflowRunSchema.parse(JSON.parse(String(row.document_json))),
      )
  }
  hasActiveProject(projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM workflow_runs WHERE project_id = ?
      AND status IN ('pending', 'running', 'waiting_user', 'cancelling') LIMIT 1`,
        )
        .get(projectId),
    )
  }
  update(value: WorkflowRun): WorkflowRun {
    const current = this.get(value.id)
    if (
      !current ||
      current.stateVersion !== value.stateVersion ||
      (current.status !== value.status &&
        !canTransitionWorkflowRun(current.status, value.status)) ||
      current.projectId !== value.projectId ||
      current.requestId !== value.requestId ||
      current.requestHash !== value.requestHash ||
      current.createdAt !== value.createdAt ||
      JSON.stringify(current.snapshot) !== JSON.stringify(value.snapshot) ||
      value.attemptsUsed < current.attemptsUsed ||
      value.tokensUsed < current.tokensUsed ||
      value.toolsUsed < current.toolsUsed ||
      value.executionMs < current.executionMs
    )
      throw new WorkflowStateConflict()
    const next = WorkflowRunSchema.parse({
      ...value,
      stateVersion: value.stateVersion + 1,
      updatedAt: new Date().toISOString(),
    })
    const changed = this.db
      .prepare(
        `UPDATE workflow_runs SET status = ?, state_version = ?, document_json = ?
      WHERE id = ? AND state_version = ?`,
      )
      .run(
        next.status,
        next.stateVersion,
        JSON.stringify(next),
        value.id,
        value.stateVersion,
      )
    if (Number(changed.changes) !== 1) throw new WorkflowStateConflict()
    return next
  }
  hasActiveDefinition(id: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM workflow_runs WHERE definition_id = ?
      AND status IN ('pending', 'running', 'waiting_user', 'cancelling') LIMIT 1`,
        )
        .get(id),
    )
  }
  requestResult(
    requestId: string,
    method: string,
    hash: string,
  ): unknown | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_requests WHERE request_id = ?')
      .get(requestId)
    if (!row) return null
    if (row.method !== method || row.request_hash !== hash)
      throw new WorkflowStateConflict()
    return JSON.parse(String(row.result_json))
  }
  recordRequest(
    projectId: string,
    requestId: string,
    method: string,
    hash: string,
    result: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO workflow_requests
      (project_id, request_id, method, request_hash, result_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, requestId, method, hash, JSON.stringify(result))
  }
}
