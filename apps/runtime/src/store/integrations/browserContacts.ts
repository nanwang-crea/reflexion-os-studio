import type { DatabaseSync } from 'node:sqlite'
import {
  BrowserContactSchema,
  type BrowserContact,
} from '@reflexion-os-studio/contracts'

export class BrowserContactsStore {
  constructor(private readonly db: DatabaseSync) {}
  list(): BrowserContact[] {
    return this.db
      .prepare(
        'SELECT contact_json FROM browser_contacts ORDER BY updated_at DESC',
      )
      .all()
      .flatMap((row) => {
        try {
          const parsed = BrowserContactSchema.safeParse(
            JSON.parse(String(row.contact_json)),
          )
          return parsed.success ? [parsed.data] : []
        } catch {
          return []
        }
      })
  }
  save(contact: BrowserContact): BrowserContact {
    const validated = BrowserContactSchema.parse(contact)
    if (
      !this.db
        .prepare('SELECT id FROM browser_contacts WHERE id = ?')
        .get(validated.id) &&
      this.list().length >= 100
    )
      throw new Error('最多保存 100 条联系信息')
    this.db
      .prepare(
        `INSERT INTO browser_contacts (id, contact_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET contact_json = excluded.contact_json, updated_at = excluded.updated_at`,
      )
      .run(validated.id, JSON.stringify(validated), new Date().toISOString())
    return validated
  }
  delete(id: string): boolean {
    return (
      this.db.prepare('DELETE FROM browser_contacts WHERE id = ?').run(id)
        .changes > 0
    )
  }
}
