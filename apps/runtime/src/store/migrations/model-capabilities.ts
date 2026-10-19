import type { DatabaseSync } from 'node:sqlite'

export function migrateModelCapabilities(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(provider_models)').all()
  for (const [name, definition] of [
    ['reasoning_mode', "TEXT NOT NULL DEFAULT 'manual'"],
    ['thinking_supported', 'INTEGER'],
    ['reasoning_capabilities_json', 'TEXT'],
  ]) {
    if (!columns.some((column) => column.name === name))
      db.exec(`ALTER TABLE provider_models ADD COLUMN ${name} ${definition}`)
  }
}
