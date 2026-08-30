import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Message,
  MessageRole,
  MessageStatus,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/** 消息领域：会话内的 user/assistant/system 消息。 */
export class MessageStore {
  constructor(private readonly db: DatabaseSync) {}

  listBySession(sessionId: string): Message[] {
    // 同毫秒创建的两条消息（user+assistant）created_at 相同，id 是随机 UUID
    // 不可作次序依据；rowid 即插入顺序，保证稳定的会话内排序。
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(sessionId)
      .map((row) => this.toMessage(row as Row))
  }

  create(input: {
    sessionId: string
    runId: string | null
    role: MessageRole
    content: string
    status: MessageStatus
  }): Message {
    const message: Message = {
      id: randomUUID(),
      sessionId: input.sessionId,
      runId: input.runId,
      role: input.role,
      content: input.content,
      reasoning: '',
      status: input.status,
      createdAt: nowIso(),
      completedAt: input.status === 'completed' ? nowIso() : null,
    }
    this.db
      .prepare(
        'INSERT INTO messages (id, session_id, run_id, role, content, reasoning, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        message.id,
        message.sessionId,
        message.runId,
        message.role,
        message.content,
        message.reasoning,
        message.status,
        message.createdAt,
        message.completedAt,
      )
    return message
  }

  /** 终态写入：正文与思考内容一并在单事务内落库（由门面保证事务）。 */
  finalize(
    id: string,
    content: string,
    status: MessageStatus,
    reasoning: string,
  ): void {
    this.db
      .prepare(
        'UPDATE messages SET content = ?, reasoning = ?, status = ?, completed_at = ? WHERE id = ?',
      )
      .run(content, reasoning, status, nowIso(), id)
  }

  markStreaming(id: string): void {
    this.db
      .prepare("UPDATE messages SET status = 'streaming' WHERE id = ?")
      .run(id)
  }

  /** 启动恢复：未完成的消息标记为 interrupted。 */
  recoverInterrupted(): void {
    this.db
      .prepare(
        `UPDATE messages SET status = 'interrupted', completed_at = ?
         WHERE status IN ('pending', 'streaming')`,
      )
      .run(nowIso())
  }

  private toMessage(row: Row): Message {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: row.run_id == null ? null : String(row.run_id),
      role: String(row.role) as MessageRole,
      content: String(row.content),
      reasoning: row.reasoning == null ? '' : String(row.reasoning),
      status: String(row.status) as MessageStatus,
      createdAt: String(row.created_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    }
  }
}
