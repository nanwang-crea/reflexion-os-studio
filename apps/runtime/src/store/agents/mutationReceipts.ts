import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ChangedFileSchema,
  type MutationReceipt,
  type ToolOutput,
} from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from '../shared.js'

export class MutationReceiptStore {
  constructor(private readonly db: DatabaseSync) {}

  record(input: {
    rootRunId: string
    runId: string
    delegationId: string | null
    agentInstanceId: string | null
    toolCallId: string
    toolName: string
    output: ToolOutput
  }): MutationReceipt | null {
    if (input.output.changedFiles.length === 0) return null
    const receipt: MutationReceipt = {
      id: randomUUID(),
      rootRunId: input.rootRunId,
      runId: input.runId,
      delegationId: input.delegationId,
      agentInstanceId: input.agentInstanceId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      changedFiles: input.output.changedFiles,
      createdAt: nowIso(),
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO mutation_receipts (
        id, root_run_id, run_id, delegation_id, agent_instance_id,
        tool_call_id, tool_name, changed_files_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.id,
        receipt.rootRunId,
        receipt.runId,
        receipt.delegationId,
        receipt.agentInstanceId,
        receipt.toolCallId,
        receipt.toolName,
        JSON.stringify(receipt.changedFiles),
        receipt.createdAt,
      )
    return receipt
  }

  listByRootRun(rootRunId: string): MutationReceipt[] {
    return this.db
      .prepare(
        'SELECT * FROM mutation_receipts WHERE root_run_id = ? ORDER BY created_at, rowid',
      )
      .all(rootRunId)
      .map((row) => this.toReceipt(row as Row))
  }

  private toReceipt(row: Row): MutationReceipt {
    return {
      id: String(row.id),
      rootRunId: String(row.root_run_id),
      runId: String(row.run_id),
      delegationId:
        row.delegation_id == null ? null : String(row.delegation_id),
      agentInstanceId:
        row.agent_instance_id == null ? null : String(row.agent_instance_id),
      toolCallId: String(row.tool_call_id),
      toolName: String(row.tool_name),
      changedFiles: ChangedFileSchema.array().parse(
        JSON.parse(String(row.changed_files_json)),
      ),
      createdAt: String(row.created_at),
    }
  }
}
