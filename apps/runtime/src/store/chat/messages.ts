import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ContentPartSchema,
  type ContentPart,
  type Message,
  type MessageRole,
  type MessageStatus,
  type HistoryCursor,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from '../shared.js'

/** content（纯文本投影）对应的 canonical 内容块。 */
function textParts(content: string): ContentPart[] {
  return content === '' ? [] : [{ type: 'text', text: content }]
}

/** 消息领域：会话内的 user/assistant/system 消息。 */
export class MessageStore {
  constructor(private readonly db: DatabaseSync) {}

  listBySession(sessionId: string, includeSuperseded = false): Message[] {
    // 同毫秒创建的两条消息（user+assistant）created_at 相同，id 是随机 UUID
    // 不可作次序依据；rowid 即插入顺序，保证稳定的会话内排序。
    const where = includeSuperseded
      ? 'session_id = ?'
      : "session_id = ? AND status <> 'superseded'"
    return this.db
      .prepare(
        `SELECT * FROM messages WHERE ${where} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId)
      .map((row) => this.toMessage(row as Row))
  }

  /** A turn starts at a user message; never cut assistant/tool rounds in half. */
  listPage(sessionId: string, turns: number, before?: HistoryCursor) {
    const boundary = before ? 'AND (created_at, rowid) < (?, ?)' : ''
    const boundaryParams = before ? [before.createdAt, before.rowId] : []
    const anchors = this.db
      .prepare(
        `SELECT rowid AS sequence, created_at FROM messages
       WHERE session_id = ? AND role = 'user' AND status <> 'superseded' ${boundary}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(sessionId, ...boundaryParams, turns + 1) as Row[]
    const hasMore = anchors.length > turns
    const start = hasMore ? anchors[turns - 1] : undefined
    const page = this.db
      .prepare(
        `SELECT rowid AS sequence, * FROM messages
       WHERE session_id = ? AND status <> 'superseded' ${boundary}
       ${start ? 'AND (created_at, rowid) >= (?, ?)' : ''}
       ORDER BY created_at ASC, rowid ASC`,
      )
      .all(
        sessionId,
        ...boundaryParams,
        ...(start ? [String(start.created_at), Number(start.sequence)] : []),
      ) as Row[]
    const cursor = (row: Row): HistoryCursor => ({
      createdAt: String(row.created_at),
      rowId: Number(row.sequence),
    })
    return {
      messages: page.map((row) => this.toMessage(row)),
      positions: Object.fromEntries(
        page.map((row) => [String(row.id), cursor(row)]),
      ),
      nextBefore: start ? cursor(start) : null,
    }
  }

  /** 某 Run 内仍未终态（pending/streaming）的消息；Finalizer 收扫用。 */
  listPendingByRun(runId: string): Message[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE run_id = ? AND status IN ('pending', 'streaming') ORDER BY created_at ASC, rowid ASC",
      )
      .all(runId)
      .map((row) => this.toMessage(row as Row))
  }

  create(input: {
    sessionId: string
    runId: string | null
    role: MessageRole
    content: string
    status: MessageStatus
    parts?: ContentPart[]
  }): Message {
    const parts = input.parts ?? textParts(input.content)
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

  referencesAsset(assetId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM messages, json_each(messages.parts_json) AS part
      WHERE json_extract(part.value, '$.type') = 'image'
        AND json_extract(part.value, '$.assetId') = ? LIMIT 1`,
        )
        .get(assetId) !== undefined
    )
  }

  markStreaming(id: string): void {
    this.db
      .prepare("UPDATE messages SET status = 'streaming' WHERE id = ?")
      .run(id)
  }

  resetPending(id: string): void {
    this.db
      .prepare(
        "UPDATE messages SET content = '', parts_json = '[]', reasoning = '', status = 'pending', completed_at = NULL WHERE id = ?",
      )
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

  markSupersededByRun(runId: string): void {
    this.db
      .prepare(
        "UPDATE messages SET status = 'superseded' WHERE run_id = ? AND role = 'assistant'",
      )
      .run(runId)
  }

  /** 编辑重发专用：旧 user 与 assistant 一并退出默认历史。 */
  markSupersededRound(runId: string): void {
    this.db
      .prepare("UPDATE messages SET status = 'superseded' WHERE run_id = ?")
      .run(runId)
  }

  markSuperseded(id: string): void {
    this.db
      .prepare("UPDATE messages SET status = 'superseded' WHERE id = ?")
      .run(id)
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
