import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ModelInvocationSchema,
  UsageSchema,
  type ModelInvocation,
  type Usage,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from '../shared.js'

type StartInput = Pick<
  ModelInvocation,
  'sessionId' | 'runId' | 'messageId' | 'providerId' | 'model' | 'purpose'
> & {
  estimatedInputTokens?: number
  contextWindow?: number
}

/** Numeric usage ledger; never accepts prompts, headers or credentials. */
export class ModelInvocationStore {
  constructor(private readonly db: DatabaseSync) {}

  start(input: StartInput): string {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO model_invocations
      (id, session_id, run_id, message_id, provider_id, model, purpose, status,
       estimated_input_tokens, context_window, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.runId,
        input.messageId,
        input.providerId,
        input.model,
        input.purpose,
        input.estimatedInputTokens ?? null,
        input.contextWindow ?? null,
        nowIso(),
      )
    return id
  }

  finish(
    id: string,
    status: 'completed' | 'failed' | 'cancelled',
    durationMs: number,
    usage?: Usage,
    errorCode?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE model_invocations SET status = ?, completed_at = ?, duration_ms = ?, usage_json = ?, error_code = ?
      WHERE id = ? AND status = 'running'`,
      )
      .run(
        status,
        nowIso(),
        Math.max(0, durationMs),
        usage ? JSON.stringify(UsageSchema.parse(usage)) : null,
        errorCode ?? null,
        id,
      )
  }

  recover(): void {
    // Crash duration and usage are unknown, not estimated from downtime.
    this.db
      .prepare(
        "UPDATE model_invocations SET status = 'interrupted', completed_at = ?, error_code = 'interrupted' WHERE status = 'running'",
      )
      .run(nowIso())
  }
}

export function modelInvocationFromRow(row: Row): ModelInvocation {
  return ModelInvocationSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    messageId: row.message_id,
    providerId: row.provider_id,
    model: row.model,
    purpose: row.purpose,
    status: row.status,
    usage: row.usage_json === null ? null : JSON.parse(String(row.usage_json)),
    estimatedInputTokens: row.estimated_input_tokens,
    contextWindow: row.context_window,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    errorCode: row.error_code,
  })
}
