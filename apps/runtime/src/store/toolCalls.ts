import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  JsonValueSchema,
  type JsonValue,
  type ToolCall,
  type ToolCallStatus,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/**
 * 工具调用领域：一次 Run 内 Agent 发起的工具调用、审批关联与结果。
 * canonical 记录所在；消息 parts 不重复保存 tool_use/tool_result。
 */
export class ToolCallStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    runId: string
    messageId: string | null
    toolName: string
    args: JsonValue
    status?: ToolCallStatus
    approvalGrantId?: string | null
  }): ToolCall {
    const toolCall: ToolCall = {
      id: randomUUID(),
      runId: input.runId,
      messageId: input.messageId,
      toolName: input.toolName,
      args: input.args,
      result: null,
      status: input.status ?? 'pending',
      errorCode: null,
      approvalGrantId: input.approvalGrantId ?? null,
      createdAt: nowIso(),
      completedAt: null,
    }
    this.db
      .prepare(
        'INSERT INTO tool_calls (id, run_id, message_id, tool_name, args_json, result_json, status, error_code, approval_grant_id, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        toolCall.id,
        toolCall.runId,
        toolCall.messageId,
        toolCall.toolName,
        JSON.stringify(toolCall.args),
        null,
        toolCall.status,
        toolCall.errorCode,
        toolCall.approvalGrantId,
        toolCall.createdAt,
        toolCall.completedAt,
      )
    return toolCall
  }

  get(id: string): ToolCall | null {
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id)
    return row ? this.toToolCall(row as Row) : null
  }

  listByRun(runId: string): ToolCall[] {
    // 排序理由同 messages：rowid 即插入顺序。
    return this.db
      .prepare(
        'SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(runId)
      .map((row) => this.toToolCall(row as Row))
  }

  listByMessage(messageId: string): ToolCall[] {
    return this.db
      .prepare(
        'SELECT * FROM tool_calls WHERE message_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(messageId)
      .map((row) => this.toToolCall(row as Row))
  }

  /** 会话维度：跨 Run 汇总该会话的全部工具调用（UI trace 用）。 */
  listBySession(sessionId: string): ToolCall[] {
    return this.db
      .prepare(
        `SELECT tc.* FROM tool_calls tc
         JOIN runs r ON tc.run_id = r.id
         WHERE r.session_id = ?
         ORDER BY tc.created_at ASC, tc.rowid ASC`,
      )
      .all(sessionId)
      .map((row) => this.toToolCall(row as Row))
  }

  /** 状态推进：进入 running 或 awaiting_approval（可携带审批授权引用）。 */
  markStatus(
    id: string,
    status: 'running' | 'awaiting_approval',
    approvalGrantId?: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE tool_calls SET status = ?, approval_grant_id = ? WHERE id = ?',
      )
      .run(status, approvalGrantId ?? null, id)
  }

  /** 终态写入：结果、错误码与完成时间一并落库（由门面保证事务）。 */
  finalize(
    id: string,
    status: 'completed' | 'failed' | 'cancelled',
    result?: JsonValue,
    errorCode?: string,
  ): void {
    this.db
      .prepare(
        'UPDATE tool_calls SET status = ?, result_json = ?, error_code = ?, completed_at = ? WHERE id = ?',
      )
      .run(
        status,
        result === undefined ? null : JSON.stringify(result),
        errorCode ?? null,
        nowIso(),
        id,
      )
  }

  /** 启动恢复：宿主崩溃后未完结的调用一律 cancelled（对应 Run 已 interrupted）。 */
  recoverUnfinished(): void {
    this.db
      .prepare(
        `UPDATE tool_calls SET status = 'cancelled', completed_at = ?
         WHERE status IN ('pending', 'awaiting_approval', 'running')`,
      )
      .run(nowIso())
  }

  private toToolCall(row: Row): ToolCall {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      messageId: row.message_id == null ? null : String(row.message_id),
      toolName: String(row.tool_name),
      args: this.parseJson(String(row.args_json ?? '{}')),
      result:
        row.result_json == null
          ? null
          : this.parseJson(String(row.result_json)),
      status: String(row.status) as ToolCallStatus,
      errorCode: row.error_code == null ? null : String(row.error_code),
      approvalGrantId:
        row.approval_grant_id == null ? null : String(row.approval_grant_id),
      createdAt: String(row.created_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    }
  }

  private parseJson(value: string): JsonValue {
    const parsed: unknown = JSON.parse(value)
    const result = JsonValueSchema.safeParse(parsed)
    return result.success ? result.data : null
  }
}
