export const WORKFLOW_AUTHORING_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  document_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_generations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL REFERENCES workflow_drafts(id) ON DELETE CASCADE,
  session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  document_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_drafts_project ON workflow_drafts(project_id);
`
