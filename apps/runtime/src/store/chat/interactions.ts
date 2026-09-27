import type { DatabaseSync } from 'node:sqlite'
import {
  UserQuestionAnswerSchema,
  UserQuestionSchema,
  type InteractionKind,
  type UserInteraction,
  type UserQuestion,
  type UserQuestionAnswer,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from '../shared.js'

/** 用户交互领域：持久化等待问题，使 Runtime 重启后仍可继续原 Run。 */
export class UserInteractionStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    id: string
    sessionId: string
    runId: string
    toolCallId: string
    kind: InteractionKind
    questions: UserQuestion[]
  }): UserInteraction {
    const interaction: UserInteraction = {
      ...input,
      answers: null,
      status: 'pending',
      createdAt: nowIso(),
      resolvedAt: null,
    }
    this.db
      .prepare(
        `INSERT INTO user_interactions
         (id, session_id, run_id, tool_call_id, kind, questions_json, answers_json, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?, NULL)`,
      )
      .run(
        interaction.id,
        interaction.sessionId,
        interaction.runId,
        interaction.toolCallId,
        interaction.kind,
        JSON.stringify(interaction.questions),
        interaction.createdAt,
      )
    return interaction
  }

  get(id: string): UserInteraction | null {
    const row = this.db
      .prepare('SELECT * FROM user_interactions WHERE id = ?')
      .get(id)
    return row ? this.toInteraction(row as Row) : null
  }

  listPending(): UserInteraction[] {
    return this.db
      .prepare(
        "SELECT * FROM user_interactions WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC",
      )
      .all()
      .map((row) => this.toInteraction(row as Row))
  }

  resolve(id: string, answers: UserQuestionAnswer[]): void {
    this.db
      .prepare(
        "UPDATE user_interactions SET answers_json = ?, status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(JSON.stringify(answers), nowIso(), id)
  }

  removePending(id: string): void {
    this.db
      .prepare(
        "DELETE FROM user_interactions WHERE id = ? AND status = 'pending'",
      )
      .run(id)
  }

  private toInteraction(row: Row): UserInteraction {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: String(row.run_id),
      toolCallId: String(row.tool_call_id),
      kind: String(row.kind) as InteractionKind,
      questions: UserQuestionSchema.array().parse(
        JSON.parse(String(row.questions_json)),
      ),
      answers:
        row.answers_json == null
          ? null
          : UserQuestionAnswerSchema.array().parse(
              JSON.parse(String(row.answers_json)),
            ),
      status: String(row.status) as 'pending' | 'resolved',
      createdAt: String(row.created_at),
      resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    }
  }
}
