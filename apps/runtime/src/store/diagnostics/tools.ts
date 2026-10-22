import type { DatabaseSync } from 'node:sqlite'
import {
  DeveloperToolSchema,
  DeveloperToolDetailSchema,
  type DeveloperToolListParams,
  type DeveloperToolPage,
} from '@reflexion-os-studio/contracts'
import type { ToolCallStore } from '../chat/toolCalls.js'
import { filterSql } from './query.js'

export class DeveloperToolQueries {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tools: ToolCallStore,
  ) {}

  list(input: DeveloperToolListParams): DeveloperToolPage {
    const query = filterSql(input, 'r', 'tc.created_at')
    for (const [column, value] of [
      ['tc.run_id', input.runId],
      ['tc.tool_name', input.toolName],
      ['tc.status', input.status],
    ] as const) {
      if (value !== undefined) {
        query.where += ` AND ${column} = ?`
        query.values.push(value)
      }
    }
    const from = `FROM tool_calls tc JOIN runs r ON r.id = tc.run_id JOIN sessions s ON s.id = r.session_id WHERE ${query.where}`
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...query.values)?.n ??
        0,
    )
    const rows = this.db
      .prepare(
        `SELECT tc.id, tc.run_id AS runId, r.session_id AS sessionId,
      s.title AS sessionTitle, s.project_id AS projectId, r.model, tc.tool_name AS toolName,
      tc.status, tc.error_code AS errorCode, tc.created_at AS createdAt, tc.completed_at AS completedAt
      ${from} ORDER BY tc.created_at DESC, tc.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...query.values, input.limit ?? 25, input.offset ?? 0)
    return { total, items: rows.map((row) => DeveloperToolSchema.parse(row)) }
  }

  get(id: string) {
    const tool = this.tools.get(id)
    return tool ? DeveloperToolDetailSchema.parse(tool) : null
  }
}
