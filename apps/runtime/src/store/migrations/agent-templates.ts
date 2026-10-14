import type { DatabaseSync } from 'node:sqlite'

export function migrateAgentTemplates(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(agents)').all()
  if (!columns.some((column) => column.name === 'project_id'))
    db.exec(
      'ALTER TABLE agents ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE',
    )
  if (!columns.some((column) => column.name === 'configuration_json'))
    db.exec(
      "ALTER TABLE agents ADD COLUMN configuration_json TEXT NOT NULL DEFAULT '{}'",
    )
}
