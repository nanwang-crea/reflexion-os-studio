import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ContentPartSchema,
  type ContentPart,
  type Message,
  type MessageRole,
  type MessageStatus,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/** content（纯文本投影）对应的 canonical 内容块。 */
function textParts(content: string): ContentPart[] {
  return content === '' ? [] : [{ type: 'text', text: content }]
}

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
    const parts = textParts(input.content)
    const message: Message = {
      id: randomUUID(),
      sessionId: input.sessionId,
      runId: input.runId,
      role: input.role,
      content: input.content,
      parts,
      reasoning: '',
      status: input.status,
      createdAt: nowIso(),
      completedAt: input.status === 'completed' ? nowIso() : null,
    }
    this.db
      .prepare(
        'INSERT INTO messages (id, session_id, run_id, role, content, parts_json, reasoning, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        message.id,
        message.sessionId,
        message.runId,
        message.role,
        message.content,
        JSON.stringify(parts),
        message.reasoning,
        message.status,
        message.createdAt,
        message.completedAt,
      )
    return message
  }

  /** 终态写入：正文、内容块与思考内容一并在单事务内落库（由门面保证事务）。 */
  finalize(
    id: string,
    content: string,
    status: MessageStatus,
    reasoning: string,
    parts?: ContentPart[],
  ): void {
    this.db
      .prepare(
        'UPDATE messages SET content = ?, parts_json = ?, reasoning = ?, status = ?, completed_at = ? WHERE id = ?',
      )
      .run(
        content,
        JSON.stringify(parts ?? textParts(content)),
        reasoning,
        status,
        nowIso(),
        id,
      )
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
      parts: this.parseParts(row),
      reasoning: row.reasoning == null ? '' : String(row.reasoning),
      status: String(row.status) as MessageStatus,
      createdAt: String(row.created_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    }
  }

  /** parts_json 解析；异常数据回退为 content 的单 text 块，不让坏行炸掉读取。 */
  private parseParts(row: Row): ContentPart[] {
    try {
      const parsed: unknown = JSON.parse(String(row.parts_json ?? '[]'))
      const result = ContentPartSchema.array().safeParse(parsed)
      if (result.success) return result.data
    } catch {
      // 落入回退分支
    }
    const content = String(row.content ?? '')
    return content === '' ? [] : [{ type: 'text', text: content }]
  }
}
