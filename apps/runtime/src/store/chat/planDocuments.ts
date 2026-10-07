import type { DatabaseSync } from 'node:sqlite'
import {
  PlanDocumentSchema,
  type PlanDocument,
} from '@reflexion-os-studio/contracts'

/** 审阅文件登记簿：快照与清理状态持久化，失败后可重试。 */
export class PlanDocumentStore {
  constructor(private readonly db: DatabaseSync) {}

  get(planId: string): PlanDocument | null {
    const row = this.db
      .prepare('SELECT document_json FROM plan_documents WHERE plan_id = ?')
      .get(planId)
    return row
      ? PlanDocumentSchema.parse(JSON.parse(String(row.document_json)))
      : null
  }

  save(document: PlanDocument): void {
    const parsed = PlanDocumentSchema.parse(document)
    this.db
      .prepare(
        'INSERT INTO plan_documents (plan_id, document_json) VALUES (?, ?) ON CONFLICT(plan_id) DO UPDATE SET document_json = excluded.document_json',
      )
      .run(parsed.snapshot.planId, JSON.stringify(parsed))
  }

  listForCleanup(): PlanDocument[] {
    return this.db
      .prepare(
        "SELECT document_json FROM plan_documents JOIN plans ON plans.id = plan_documents.plan_id WHERE plans.status IN ('completed', 'cancelled') AND json_extract(document_json, '$.state') IN ('active', 'cleanup_pending') LIMIT 100",
      )
      .all()
      .map((row) =>
        PlanDocumentSchema.parse(JSON.parse(String(row.document_json))),
      )
      .filter(
        (document) =>
          document.state === 'active' || document.state === 'cleanup_pending',
      )
  }
}
