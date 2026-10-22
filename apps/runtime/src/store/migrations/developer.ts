import type { DatabaseSync } from 'node:sqlite'

export const DEVELOPER_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_invocations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  provider_id TEXT,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  usage_json TEXT,
  estimated_input_tokens INTEGER,
  context_window INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms REAL,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_invocations_run ON model_invocations(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_model_invocations_session ON model_invocations(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_model_invocations_time ON model_invocations(started_at);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON tool_calls(created_at);
`

export function migrateDeveloper(db: DatabaseSync): void {
  db.exec(DEVELOPER_SCHEMA)
  const columns = db.prepare('PRAGMA table_info(tool_calls)').all()
  if (!columns.some((column) => column.name === 'timing_json'))
    db.exec('ALTER TABLE tool_calls ADD COLUMN timing_json TEXT')
}
