import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  WorkflowDefinitionSchema,
  WorkflowVersionSchema,
  type WorkflowDefinition,
  type WorkflowVersion,
  type WorkflowDraft,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from '../shared.js'

export class WorkflowRevisionConflict extends Error {
  readonly code = 'workflow_revision_conflict'
  constructor() {
    super('Workflow was changed or archived; reload before saving')
  }
}

/** Definitions are immutable versions; updates compare the current head revision. */
export class WorkflowDefinitionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(fn: () => T) => T,
  ) {}

  save(input: {
    id?: string
    projectId: string
    requestId?: string
    requestHash?: string
    baseRevision: number
    definition: WorkflowDefinition
    origin: WorkflowVersion['origin']
    onSaved?: (version: WorkflowVersion) => WorkflowDraft
  }): WorkflowVersion {
    const definition = WorkflowDefinitionSchema.parse(input.definition)
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0)
      throw new WorkflowRevisionConflict()
    return this.transaction(() => {
      if (input.requestId) {
        const result = this.db
          .prepare('SELECT * FROM workflow_requests WHERE request_id = ?')
          .get(input.requestId)
        if (result) {
          if (
            result.method !== 'workflow.save' ||
            result.request_hash !== input.requestHash
          )
            throw new WorkflowRevisionConflict()
          return WorkflowVersionSchema.parse(
            JSON.parse(String(result.result_json)).version,
          )
        }
      }
      const now = nowIso()
      const id = input.id ?? randomUUID()
      const revision = input.baseRevision + 1
      if (input.id) {
        const updated = this.db
          .prepare(
            `UPDATE workflow_definitions
          SET revision = ?, updated_at = ?
          WHERE id = ? AND project_id = ? AND revision = ? AND archived = 0`,
          )
          .run(revision, now, id, input.projectId, input.baseRevision)
        if (Number(updated.changes) !== 1) throw new WorkflowRevisionConflict()
      } else {
        if (input.baseRevision !== 0) throw new WorkflowRevisionConflict()
        this.db
          .prepare(
            `INSERT INTO workflow_definitions
          (id, project_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, input.projectId, revision, now, now)
      }
      const version = WorkflowVersionSchema.parse({
        definitionId: id,
        projectId: input.projectId,
        revision,
        definition,
        origin: input.origin,
        createdAt: now,
      })
      this.db
        .prepare(
          `INSERT INTO workflow_versions
        (definition_id, revision, definition_json, origin, created_at)
        VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, revision, JSON.stringify(definition), input.origin, now)
      const draft = input.onSaved?.(version)
      if (input.requestId)
        this.db
          .prepare(
            `INSERT INTO workflow_requests
        (project_id, request_id, method, request_hash, result_json) VALUES (?, ?, 'workflow.save', ?, ?)`,
          )
          .run(
            input.projectId,
            input.requestId,
            input.requestHash!,
            JSON.stringify({ version, draft }),
          )
      return version
    })
  }

  get(
    projectId: string,
    id: string,
    revision?: number,
  ): WorkflowVersion | null {
    const row = this.db
      .prepare(
        `SELECT v.*, d.project_id FROM workflow_versions v
      JOIN workflow_definitions d ON d.id = v.definition_id
      WHERE d.project_id = ? AND d.id = ? AND v.revision = COALESCE(?, d.revision)`,
      )
      .get(projectId, id, revision ?? null) as Row | undefined
    return row ? this.toVersion(row) : null
  }

  list(projectId: string, includeArchived = false): WorkflowVersion[] {
    return this.db
      .prepare(
        `SELECT v.*, d.project_id FROM workflow_definitions d
      JOIN workflow_versions v ON v.definition_id = d.id AND v.revision = d.revision
      WHERE d.project_id = ? AND (d.archived = 0 OR ? = 1)
      ORDER BY d.updated_at DESC, d.id`,
      )
      .all(projectId, includeArchived ? 1 : 0)
      .map((row) => this.toVersion(row as Row))
  }

  archive(projectId: string, id: string, baseRevision: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE workflow_definitions
      SET archived = 1, updated_at = ?
      WHERE project_id = ? AND id = ? AND revision = ? AND archived = 0`,
      )
      .run(nowIso(), projectId, id, baseRevision)
    return Number(result.changes) === 1
  }

  isArchived(projectId: string, id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT archived FROM workflow_definitions
      WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, id) as Row | undefined
    return !row || Boolean(row.archived)
  }

  private toVersion(row: Row): WorkflowVersion {
    return WorkflowVersionSchema.parse({
      definitionId: row.definition_id,
      projectId: row.project_id,
      revision: row.revision,
      definition: JSON.parse(String(row.definition_json)),
      origin: row.origin,
      createdAt: row.created_at,
    })
  }
}
