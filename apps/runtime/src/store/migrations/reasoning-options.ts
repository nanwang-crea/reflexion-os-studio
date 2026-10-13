import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_REASONING_OPTIONS } from '@reflexion-os-studio/contracts'

export function migrateReasoningOptions(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(provider_models)').all()
  if (columns.some((column) => column.name === 'reasoning_options_json')) return
  const defaults = JSON.stringify(DEFAULT_REASONING_OPTIONS).replaceAll(
    "'",
    "''",
  )
  db.exec(
    `ALTER TABLE provider_models ADD COLUMN reasoning_options_json TEXT NOT NULL DEFAULT '${defaults}'`,
  )
}
