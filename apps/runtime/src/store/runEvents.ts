import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { RunEvent } from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

type RunEventRow = Row & {
  id: string
  session_id: string
  run_id: string
  type: 'retrying' | 'failed'
  attempt: number | null
  max_retries: number | null
  reason: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
}

export class RunEventStore {
  constructor(private readonly db: DatabaseSync) {}

  createRetrying(input: {
    sessionId: string
    runId: string
    attempt: number
    maxRetries: number
    reason: string
  }): RunEvent {
    return this.insert({
      ...input,
      type: 'retrying',
      errorCode: null,
      errorMessage: null,
    })
  }

  createFailed(input: {
    sessionId: string
    runId: string
    errorCode: string
    errorMessage: string
  }): RunEvent {
    return this.insert({
      ...input,
      type: 'failed',
      attempt: null,
      maxRetries: null,
      reason: null,
    })
  }

  listBySession(sessionId: string): RunEvent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM run_events WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(sessionId) as unknown as RunEventRow[]
    return rows.map(toRunEvent)
  }

  private insert(input: {
    sessionId: string
    runId: string
    type: 'retrying' | 'failed'
    attempt?: number | null
    maxRetries?: number | null
    reason?: string | null
    errorCode: string | null
    errorMessage: string | null
  }): RunEvent {
    const event: RunEvent = {
      id: randomUUID(),
      sessionId: input.sessionId,
      runId: input.runId,
      type: input.type,
      attempt: input.attempt ?? null,
      maxRetries: input.maxRetries ?? null,
      reason: input.reason ?? null,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      createdAt: nowIso(),
    }
    this.db
      .prepare(
        `INSERT INTO run_events
         (id, session_id, run_id, type, attempt, max_retries, reason, error_code, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.sessionId,
        event.runId,
        event.type,
        event.attempt,
        event.maxRetries,
        event.reason,
        event.errorCode,
        event.errorMessage,
        event.createdAt,
      )
    return event
  }
}

function toRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    type: row.type,
    attempt: row.attempt,
    maxRetries: row.max_retries,
    reason: row.reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  }
}
