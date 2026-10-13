/** Phase 4 W0: immutable project-scoped definitions. Execution tables follow W1. */
export const WORKFLOW_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_definitions_project
  ON workflow_definitions(project_id, updated_at);
CREATE TABLE IF NOT EXISTS workflow_versions (
  definition_id TEXT NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  definition_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'nl-generated')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (definition_id, revision)
);
`

export const WORKFLOW_EXECUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  FOREIGN KEY (definition_id, definition_revision)
    REFERENCES workflow_versions(definition_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_project ON workflow_runs(project_id);
CREATE TABLE IF NOT EXISTS workflow_node_attempts (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  agent_run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
  session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  document_json TEXT NOT NULL,
  UNIQUE (workflow_run_id, node_id, attempt_no)
);
CREATE TABLE IF NOT EXISTS workflow_outputs (
  attempt_id TEXT PRIMARY KEY REFERENCES workflow_node_attempts(id) ON DELETE CASCADE,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  document_json TEXT NOT NULL,
  UNIQUE (workflow_run_id, node_id)
);
CREATE TABLE IF NOT EXISTS workflow_confirmations (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES workflow_node_attempts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  document_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_requests (
  request_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL
);
`

export const WORKFLOW_RESULT_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_attempt_results (
  attempt_id TEXT PRIMARY KEY REFERENCES workflow_node_attempts(id) ON DELETE CASCADE,
  document_json TEXT NOT NULL
);
`
