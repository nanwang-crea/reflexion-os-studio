import type { DatabaseSync } from 'node:sqlite'

/** Preserve existing assets while allowing standalone session uploads. */
export function migrateImageAssets(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(assets)').all()
  if (columns.some((column) => column.name === 'session_id')) return
  db.exec(`
    ALTER TABLE assets RENAME TO assets_v38;
    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT, node_run_id TEXT,
      file_name TEXT NOT NULL, kind TEXT NOT NULL, mime_type TEXT NOT NULL,
      size INTEGER NOT NULL, hash TEXT NOT NULL, uri TEXT NOT NULL,
      created_by TEXT NOT NULL, preview_status TEXT NOT NULL DEFAULT 'ready',
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    INSERT INTO assets (id, project_id, run_id, node_run_id, file_name, kind,
      mime_type, size, hash, uri, created_by, preview_status, metadata_json, created_at)
      SELECT id, project_id, run_id, node_run_id, file_name, kind,
      mime_type, size, hash, uri, created_by, preview_status, metadata_json, created_at
      FROM assets_v38;
    DROP TABLE assets_v38;
  `)
}
