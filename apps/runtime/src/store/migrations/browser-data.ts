import type { DatabaseSync } from 'node:sqlite'
export const BROWSER_DATA_SCHEMA = `
    CREATE TABLE IF NOT EXISTS browser_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, origin TEXT NOT NULL,
      title TEXT NOT NULL, visited_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_browser_history_origin ON browser_history(origin, id);
    CREATE TABLE IF NOT EXISTS browser_contacts (
      id TEXT PRIMARY KEY, contact_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
`

export function migrateBrowserData(db: DatabaseSync): void {
  db.exec(BROWSER_DATA_SCHEMA)
}
