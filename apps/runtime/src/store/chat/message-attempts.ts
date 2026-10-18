import type { DatabaseSync } from 'node:sqlite'
import {
  ProviderRequestAttemptSchema,
  type ProviderRequestAttempt,
} from '@reflexion-os-studio/contracts'
import { nowIso } from '../shared.js'

export function parseRequestAttempts(value: unknown): ProviderRequestAttempt[] {
  return ProviderRequestAttemptSchema.array().parse(
    JSON.parse(String(value ?? '[]')),
  )
}

/** Attempt snapshots belong to their message and share its deletion lifecycle. */
export class MessageAttemptStore {
  constructor(private readonly db: DatabaseSync) {}

  read(id: string): ProviderRequestAttempt[] {
    const row = this.db
      .prepare('SELECT request_attempts_json FROM messages WHERE id = ?')
      .get(id)
    return parseRequestAttempts(row?.request_attempts_json)
  }

  record(id: string, attempt: ProviderRequestAttempt): void {
    const attempts = this.read(id)
    const index = attempts.findIndex((entry) => entry.id === attempt.id)
    const validated = ProviderRequestAttemptSchema.parse(attempt)
    if (index < 0) attempts.push(validated)
    else attempts[index] = validated
    this.db
      .prepare('UPDATE messages SET request_attempts_json = ? WHERE id = ?')
      .run(JSON.stringify(attempts), id)
  }

  /** Bind this projection into the same UPDATE that persists the canonical answer. */
  finalizedJson(id: string): string {
    return JSON.stringify(
      this.read(id).map((attempt) =>
        attempt.status === 'completed'
          ? { ...attempt, content: '', reasoning: '' }
          : attempt,
      ),
    )
  }

  recoverInterrupted(): void {
    const rows = this.db
      .prepare(
        "SELECT id, request_attempts_json FROM messages WHERE status IN ('pending', 'streaming')",
      )
      .all()
    for (const row of rows) {
      for (const attempt of parseRequestAttempts(row.request_attempts_json)) {
        // A completed request may still be waiting for canonical message commit.
        if (attempt.status === 'running' || attempt.status === 'completed') {
          this.record(String(row.id), {
            ...attempt,
            status: 'interrupted',
            completedAt: attempt.completedAt ?? nowIso(),
          })
        }
      }
    }
  }
}
