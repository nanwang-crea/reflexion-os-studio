import type { DatabaseSync } from 'node:sqlite'
import {
  OperationSnapshotSchema,
  type OperationSnapshot,
} from '@reflexion-os-studio/contracts'

export class OperationReceiptStore {
  constructor(private readonly db: DatabaseSync) {}

  get(
    key: string,
  ): { fingerprint: string; snapshot: OperationSnapshot } | null {
    const row = this.db
      .prepare(
        'SELECT fingerprint, snapshot_json FROM operation_receipts WHERE request_key = ?',
      )
      .get(key)
    return row
      ? {
          fingerprint: String(row.fingerprint),
          snapshot: OperationSnapshotSchema.parse(
            JSON.parse(String(row.snapshot_json)),
          ),
        }
      : null
  }

  save(key: string, fingerprint: string, snapshot: OperationSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO operation_receipts VALUES (?, ?, ?)
      ON CONFLICT(request_key) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
      )
      .run(key, fingerprint, JSON.stringify(snapshot))
  }

  recover(): void {
    this.db
      .exec(`UPDATE operation_receipts SET snapshot_json = json_set(snapshot_json, '$.phase', 'uncertain', '$.error', '运行时已重启，操作结果需核对，禁止重放')
      WHERE json_extract(snapshot_json, '$.phase') IN ('queued', 'running')`)
  }
}
