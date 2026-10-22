import type { DatabaseSync } from 'node:sqlite'
import {
  DeveloperAttemptSchema,
  type DeveloperFilter,
  type DeveloperModelPage,
  type DeveloperAttemptPage,
} from '@reflexion-os-studio/contracts'
import { modelInvocationFromRow } from './modelInvocations.js'
import { filterSql } from './query.js'

export class DeveloperModelQueries {
  constructor(private readonly db: DatabaseSync) {}

  list(
    input: DeveloperFilter & {
      runId?: string
      offset?: number
      limit?: number
    },
  ): DeveloperModelPage {
    const query = filterSql(input, 'i')
    if (input.runId !== undefined) {
      query.where += ' AND i.run_id = ?'
      query.values.push(input.runId)
    }
    const from = `FROM model_invocations i JOIN sessions s ON s.id = i.session_id WHERE ${query.where}`
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...query.values)?.n ??
        0,
    )
    const rows = this.db
      .prepare(
        `SELECT i.* ${from} ORDER BY i.started_at DESC, i.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...query.values, input.limit ?? 25, input.offset ?? 0)
    return { total, items: rows.map(modelInvocationFromRow) }
  }

  attempts(
    messageId: string,
    offset: number,
    limit: number,
  ): DeveloperAttemptPage {
    // Extract only diagnostic fields, never materialize interrupted response bodies.
    const from = `FROM messages m, json_each(m.request_attempts_json) a WHERE m.id = ?`
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(messageId)?.n ?? 0,
    )
    const rows = this.db
      .prepare(
        `SELECT json_remove(a.value, '$.content', '$.reasoning') AS value ${from}
      ORDER BY CAST(a.key AS INTEGER) LIMIT ? OFFSET ?`,
      )
      .all(messageId, limit, offset)
    return {
      total,
      items: rows.map((row) =>
        DeveloperAttemptSchema.parse(JSON.parse(String(row.value))),
      ),
    }
  }
}
