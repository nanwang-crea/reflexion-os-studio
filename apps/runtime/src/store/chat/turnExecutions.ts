import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  type JsonValue,
  type TurnExecution,
  type TurnPhase,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from '../shared.js'

const TERMINAL_PHASES = new Set<TurnPhase>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export interface TurnExecutionPatch {
  modelRequest?: JsonValue | null
  assistantMessageId?: string | null
  toolBatch?: JsonValue | null
  pendingInteractionId?: string | null
  pendingApprovalId?: string | null
  continuationReason?: string | null
  runtimeState?: JsonValue | null
}

export interface TurnRecoveryDecision {
  turnId: string
  runId: string
  action: 'resume_user_input' | 'interrupt'
  reason: string
}

/** Persisted Turn state and the single startup recovery reducer. */
export class TurnExecutionStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    runId: string
    attempt: number
    phase?: TurnPhase
    modelRequest?: JsonValue | null
  }): TurnExecution {
    const now = nowIso()
    const turn: TurnExecution = {
      id: randomUUID(),
      runId: input.runId,
      phase: input.phase ?? 'processing_input',
      attempt: input.attempt,
      modelRequest: input.modelRequest ?? null,
      assistantMessageId: null,
      toolBatch: null,
      pendingInteractionId: null,
      pendingApprovalId: null,
      continuationReason: null,
      runtimeState: null,
      checkpointVersion: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO turn_executions
         (id, run_id, phase, attempt, model_request_json, assistant_message_id,
          tool_batch_json, pending_interaction_id, pending_approval_id,
          continuation_reason, runtime_state_json, checkpoint_version, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?, NULL)`,
      )
      .run(
        turn.id,
        turn.runId,
        turn.phase,
        turn.attempt,
        stringifyNullable(turn.modelRequest),
        now,
        now,
      )
    return turn
  }

  get(id: string): TurnExecution | null {
    const row = this.db
      .prepare('SELECT * FROM turn_executions WHERE id = ?')
      .get(id)
    return row ? this.toTurn(row as Row) : null
  }

  latestForRun(runId: string): TurnExecution | null {
    const row = this.db
      .prepare(
        'SELECT * FROM turn_executions WHERE run_id = ? ORDER BY attempt DESC LIMIT 1',
      )
      .get(runId)
    return row ? this.toTurn(row as Row) : null
  }

  transition(
    id: string,
    phase: TurnPhase,
    patch: TurnExecutionPatch = {},
  ): TurnExecution {
    const current = this.get(id)
    if (!current) throw new Error(`turn execution not found: ${id}`)
    if (TERMINAL_PHASES.has(current.phase)) {
      if (current.phase === phase) return current
      throw new Error(
        `cannot transition terminal turn ${id} from ${current.phase}`,
      )
    }
    const updatedAt = nowIso()
    const completedAt = TERMINAL_PHASES.has(phase) ? updatedAt : null
    const next = {
      modelRequest: patch.modelRequest ?? current.modelRequest,
      assistantMessageId:
        patch.assistantMessageId === undefined
          ? current.assistantMessageId
          : patch.assistantMessageId,
      toolBatch:
        patch.toolBatch === undefined ? current.toolBatch : patch.toolBatch,
      pendingInteractionId:
        patch.pendingInteractionId === undefined
          ? current.pendingInteractionId
          : patch.pendingInteractionId,
      pendingApprovalId:
        patch.pendingApprovalId === undefined
          ? current.pendingApprovalId
          : patch.pendingApprovalId,
      continuationReason:
        patch.continuationReason === undefined
          ? current.continuationReason
          : patch.continuationReason,
      runtimeState:
        patch.runtimeState === undefined
          ? current.runtimeState
          : patch.runtimeState,
    }
    this.db
      .prepare(
        `UPDATE turn_executions
         SET phase = ?, model_request_json = ?, assistant_message_id = ?,
             tool_batch_json = ?, pending_interaction_id = ?,
             pending_approval_id = ?, continuation_reason = ?, runtime_state_json = ?,
             updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        phase,
        stringifyNullable(next.modelRequest),
        next.assistantMessageId,
        stringifyNullable(next.toolBatch),
        next.pendingInteractionId,
        next.pendingApprovalId,
        next.continuationReason,
        stringifyNullable(next.runtimeState),
        updatedAt,
        completedAt,
        id,
      )
    return this.get(id)!
  }

  /**
   * Startup reducer. Only a persisted user interaction is safe to resume.
   * Model calls, approvals and tools lack replay/idempotency guarantees today.
   */
  recoverNonTerminal(): TurnRecoveryDecision[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, r.delegation_id,
                EXISTS(
                  SELECT 1 FROM user_interactions i
                  WHERE i.id = t.pending_interaction_id AND i.status = 'pending'
                ) AS has_pending_interaction
         FROM turn_executions t
         JOIN runs r ON r.id = t.run_id
         WHERE t.completed_at IS NULL
         ORDER BY t.created_at ASC, t.rowid ASC`,
      )
      .all() as Array<Row & { has_pending_interaction: number | bigint }>
    return rows.map((row) => {
      const turn = this.toTurn(row)
      if (
        turn.phase === 'awaiting_user_input' &&
        row.delegation_id == null &&
        Number(row.has_pending_interaction) === 1
      ) {
        return {
          turnId: turn.id,
          runId: turn.runId,
          action: 'resume_user_input',
          reason: 'persisted_interaction',
        }
      }
      this.transition(turn.id, 'interrupted', {
        continuationReason: `recovery_unsafe_phase:${turn.phase}`,
      })
      return {
        turnId: turn.id,
        runId: turn.runId,
        action: 'interrupt',
        reason: `unsafe_phase:${turn.phase}`,
      }
    })
  }

  private toTurn(row: Row): TurnExecution {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      phase: String(row.phase) as TurnPhase,
      attempt: Number(row.attempt),
      modelRequest: parseNullable(row.model_request_json),
      assistantMessageId:
        row.assistant_message_id == null
          ? null
          : String(row.assistant_message_id),
      toolBatch: parseNullable(row.tool_batch_json),
      pendingInteractionId:
        row.pending_interaction_id == null
          ? null
          : String(row.pending_interaction_id),
      pendingApprovalId:
        row.pending_approval_id == null
          ? null
          : String(row.pending_approval_id),
      continuationReason:
        row.continuation_reason == null
          ? null
          : String(row.continuation_reason),
      runtimeState: parseNullable(row.runtime_state_json),
      checkpointVersion: Number(row.checkpoint_version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    }
  }
}

function stringifyNullable(value: JsonValue | null): string | null {
  return value === null ? null : JSON.stringify(value)
}

function parseNullable(value: unknown): JsonValue | null {
  return value == null ? null : (JSON.parse(String(value)) as JsonValue)
}
