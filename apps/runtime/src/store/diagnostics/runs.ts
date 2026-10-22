import type { DatabaseSync } from 'node:sqlite'
import {
  DeveloperRunSchema,
  DeveloperRunDetailSchema,
  type DeveloperRunListParams,
  type DeveloperRunPage,
  type DeveloperRunDetail,
} from '@reflexion-os-studio/contracts'
import type { RunStore } from '../chat/runs.js'
import type { Row } from '../shared.js'
import { filterSql, USAGE_AGGREGATES, VALID_USAGE } from './query.js'

const projection = `SELECT r.id, s.title AS sessionTitle, s.project_id AS projectId,
  p.name AS projectName, pp.name AS providerName,
  (SELECT COUNT(*) FROM tool_calls tc WHERE tc.run_id = r.id) AS toolCalls,
  (SELECT COUNT(*) FROM tool_calls tc WHERE tc.run_id = r.id AND tc.status = 'failed') AS toolFailures,
  (SELECT COUNT(*) FROM runs child WHERE child.parent_run_id = r.id) AS childRuns
  FROM runs r JOIN sessions s ON s.id = r.session_id
  LEFT JOIN projects p ON p.id = s.project_id
  LEFT JOIN provider_profiles pp ON pp.id = r.provider_id`

export class DeveloperRunQueries {
  constructor(
    private readonly db: DatabaseSync,
    private readonly runs: RunStore,
  ) {}

  list(input: DeveloperRunListParams): DeveloperRunPage {
    const query = filterSql(input)
    if (input.status) {
      query.where += ' AND r.status = ?'
      query.values.push(input.status)
    }
    if (input.parentRunId !== undefined) {
      query.where +=
        input.parentRunId === null
          ? ' AND r.parent_run_id IS NULL'
          : ' AND r.parent_run_id = ?'
      if (input.parentRunId !== null) query.values.push(input.parentRunId)
    }
    const total = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs r JOIN sessions s ON s.id = r.session_id WHERE ${query.where}`,
        )
        .get(...query.values)?.n ?? 0,
    )
    const rows = this.db
      .prepare(
        `${projection} WHERE ${query.where} ORDER BY r.started_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...query.values, input.limit ?? 25, input.offset ?? 0)
    return { total, items: rows.map((row) => this.entry(row)) }
  }

  get(runId: string): DeveloperRunDetail | null {
    const row = this.db.prepare(`${projection} WHERE r.id = ?`).get(runId)
    if (!row) return null
    const aggregate = this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
      SELECT id FROM runs WHERE id = ?
      UNION SELECT r.id FROM runs r JOIN tree t ON r.parent_run_id = t.id
    ), sources AS (
      SELECT ${VALID_USAGE('r.usage_json')} AS usage,
        (SELECT COUNT(*) FROM model_invocations i WHERE i.run_id = r.id AND i.purpose = 'chat' AND i.usage_json IS NULL) AS unreported,
        NOT EXISTS(SELECT 1 FROM model_invocations i WHERE i.run_id = r.id AND i.purpose = 'chat') AS legacy
      FROM runs r JOIN tree ON tree.id = r.id
    ) SELECT ${USAGE_AGGREGATES} FROM sources`,
      )
      .get(runId)
    return DeveloperRunDetailSchema.parse({
      entry: this.entry(row),
      treeUsage: aggregate,
      treeRuns: aggregate?.sources,
    })
  }

  private entry(row: Row) {
    return DeveloperRunSchema.parse({
      ...row,
      run: this.runs.get(String(row.id)),
    })
  }
}
