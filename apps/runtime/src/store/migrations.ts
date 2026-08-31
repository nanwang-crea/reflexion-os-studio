// 存储结构定义与版本化迁移：schema DDL、user_version 推进、旧库重建。
// 迁移涉及 SQLite 无法直接改列约束的表，需在 foreign_keys=OFF +
// legacy_alter_table=ON 的事务内重建，任一步失败整体回滚。
import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  parts_json TEXT NOT NULL DEFAULT '[]',
  reasoning TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  retry_of_run_id TEXT,
  agent_id TEXT,
  parent_run_id TEXT,
  delegation_id TEXT,
  skill_id TEXT,
  usage_json TEXT
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  approval_grant_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '["chat"]',
  secret_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  temperature REAL,
  max_tokens INTEGER,
  context_window INTEGER,
  context_budget INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  source_run_id TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  embedding BLOB,
  embedding_model TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id);
-- A2 Memory 全文索引：trigram 分词对中文子串检索有效（unicode61 无法切分 CJK）。
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tokenize='trigram',
  content='memories',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
-- MCP server 配置与最后运行状态(工具清单在运行时内存)。
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'disabled',
  tool_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
-- Agent 运行时全局设置(单行 JSON,id 恒为 1)。
CREATE TABLE IF NOT EXISTS agent_settings (
  id INTEGER PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Phase 1B：每项目一份 Workspace 索引快照；项目删除级联清掉。
CREATE TABLE IF NOT EXISTS workspace_index (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  stale_at TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  dir_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  ext_stats_json TEXT NOT NULL DEFAULT '[]',
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
-- Phase 1B：Asset 元数据与引用(内容在数据目录 assets/<projectId>/,
-- 按项目隔离);run_id 产出来源,node_run_id 多 Agent 阶段预留。
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  node_run_id TEXT,
  file_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  uri TEXT NOT NULL,
  created_by TEXT NOT NULL,
  preview_status TEXT NOT NULL DEFAULT 'ready',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`

/** 当前 schema 版本；递增时必须在 runMigrations 中补充对应升级路径。 */
export const LATEST_SCHEMA_VERSION = 13

const SESSIONS_TABLE_V1 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`

const PROJECTS_TABLE_V1 = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`

const PROVIDER_PROFILES_TABLE_V2 = `
CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL
)`

interface TableColumn {
  name: string
  notnull: number | bigint
}

function tableColumns(db: DatabaseSync, table: string): TableColumn[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as TableColumn[]
}

/**
 * 分版本迁移；SQLite 无法直接改列约束，重建表需在关闭外键 + legacy_alter_table 下进行。
 * v0 → v1：sessions.project_id 改为可空（独立会话），projects 增加 folder_path。
 * v1 → v2：provider_profiles 单 model 列改为 models JSON 数组（多模型）。
 * v2 → v3：messages 增加 reasoning 列（推理模型思考内容）。
 * v3 → v4：Agent 契约地基——messages 增加 parts_json（content 一次性回填为单 text 块）、
 *          runs 增加 agent_id/parent_run_id/delegation_id、provider_profiles 增加 capabilities、
 *          tool_calls 表由 SCHEMA 创建。
 * v4 → v5：A2 Memory——memories 表 + FTS5 索引 + 同步触发器由 SCHEMA 创建（全新表，
 *          无历史数据回填；升级只推进版本号）。
 * v5 → v6：runs 增加 skill_id 列（Skill 激活来源记录；加列可直接 ALTER TABLE）。
 * 各步骤带形状检测：SCHEMA 刚建好的新库不会空跑重建。
 */
export function runMigrations(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as
    { user_version: number | bigint } | undefined
  let version = Number(row?.user_version ?? 0)
  if (version >= LATEST_SCHEMA_VERSION) return
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('PRAGMA legacy_alter_table = ON')
  db.exec('BEGIN IMMEDIATE')
  try {
    if (version < 1) {
      const sessionsLegacy = tableColumns(db, 'sessions').some(
        (column) =>
          column.name === 'project_id' && Number(column.notnull) === 1,
      )
      if (sessionsLegacy) {
        db.exec('ALTER TABLE sessions RENAME TO sessions_v0')
        db.exec(SESSIONS_TABLE_V1)
        db.exec(
          `INSERT INTO sessions (id, project_id, title, status, created_at, updated_at)
           SELECT id, project_id, title, status, created_at, updated_at FROM sessions_v0`,
        )
        db.exec('DROP TABLE sessions_v0')
      }
      const projectsLegacy = !tableColumns(db, 'projects').some(
        (column) => column.name === 'folder_path',
      )
      if (projectsLegacy) {
        db.exec('ALTER TABLE projects RENAME TO projects_v0')
        db.exec(PROJECTS_TABLE_V1)
        db.exec(
          `INSERT INTO projects (id, name, folder_path, created_at, updated_at)
           SELECT id, name, '', created_at, updated_at FROM projects_v0`,
        )
        db.exec('DROP TABLE projects_v0')
      }
    }
    if (version < 2) {
      const providerLegacy = tableColumns(db, 'provider_profiles').some(
        (column) => column.name === 'model',
      )
      if (providerLegacy) {
        // 单 model 列 → models JSON 数组（多模型供应商）。
        db.exec('ALTER TABLE provider_profiles RENAME TO provider_profiles_v1')
        db.exec(PROVIDER_PROFILES_TABLE_V2)
        const legacy = db
          .prepare(
            'SELECT id, name, base_url, model, secret_ref, enabled, updated_at FROM provider_profiles_v1',
          )
          .all() as {
          id: string
          name: string
          base_url: string
          model: string
          secret_ref: string
          enabled: number
          updated_at: string
        }[]
        const insert = db.prepare(
          'INSERT INTO provider_profiles (id, name, base_url, models, secret_ref, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        for (const row of legacy) {
          insert.run(
            row.id,
            row.name,
            row.base_url,
            JSON.stringify([row.model]),
            row.secret_ref,
            row.enabled,
            row.updated_at,
          )
        }
        db.exec('DROP TABLE provider_profiles_v1')
      }
    }
    if (version < 3) {
      const hasReasoning = tableColumns(db, 'messages').some(
        (column) => column.name === 'reasoning',
      )
      if (!hasReasoning) {
        // 加列可直接 ALTER TABLE，无需重建表。
        db.exec(
          "ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''",
        )
      }
    }
    if (version < 4) {
      if (
        !tableColumns(db, 'messages').some(
          (column) => column.name === 'parts_json',
        )
      ) {
        db.exec(
          "ALTER TABLE messages ADD COLUMN parts_json TEXT NOT NULL DEFAULT '[]'",
        )
      }
      // 一次性迁移：content → 单 text 内容块；此后 parts 为 canonical 表示。
      const legacyRows = db
        .prepare(
          "SELECT id, content FROM messages WHERE parts_json = '[]' AND content <> ''",
        )
        .all() as { id: string; content: string }[]
      const backfill = db.prepare(
        'UPDATE messages SET parts_json = ? WHERE id = ?',
      )
      for (const row of legacyRows) {
        backfill.run(
          JSON.stringify([{ type: 'text', text: String(row.content) }]),
          String(row.id),
        )
      }
      const runColumns = tableColumns(db, 'runs').map((column) => column.name)
      for (const column of ['agent_id', 'parent_run_id', 'delegation_id']) {
        if (!runColumns.includes(column)) {
          db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`)
        }
      }
      if (
        !tableColumns(db, 'provider_profiles').some(
          (column) => column.name === 'capabilities',
        )
      ) {
        db.exec(
          `ALTER TABLE provider_profiles ADD COLUMN capabilities TEXT NOT NULL DEFAULT '["chat"]'`,
        )
      }
    }
    if (version < 6) {
      if (
        !tableColumns(db, 'runs').some((column) => column.name === 'skill_id')
      ) {
        db.exec('ALTER TABLE runs ADD COLUMN skill_id TEXT')
      }
    }
    // v7：workspace_index 表为纯新增（SCHEMA CREATE TABLE IF NOT EXISTS
    // 已覆盖新库与旧库），迁移只需推进版本号。
    if (version < 8) {
      const providerColumns = tableColumns(db, 'provider_profiles').map(
        (column) => column.name,
      )
      if (!providerColumns.includes('temperature')) {
        db.exec('ALTER TABLE provider_profiles ADD COLUMN temperature REAL')
      }
      if (!providerColumns.includes('max_tokens')) {
        db.exec('ALTER TABLE provider_profiles ADD COLUMN max_tokens INTEGER')
      }
      if (
        !tableColumns(db, 'runs').some((column) => column.name === 'usage_json')
      ) {
        db.exec('ALTER TABLE runs ADD COLUMN usage_json TEXT')
      }
    }
    if (version < 9) {
      if (
        !tableColumns(db, 'provider_profiles').some(
          (column) => column.name === 'context_window',
        )
      ) {
        db.exec(
          'ALTER TABLE provider_profiles ADD COLUMN context_window INTEGER',
        )
      }
    }
    if (version < 10) {
      if (
        !tableColumns(db, 'provider_profiles').some(
          (column) => column.name === 'context_budget',
        )
      ) {
        db.exec(
          'ALTER TABLE provider_profiles ADD COLUMN context_budget INTEGER',
        )
      }
    }
    db.exec('COMMIT')
    // 迁移全部执行完毕才推进版本号；否则下次启动会重复进入迁移分支。
    version = LATEST_SCHEMA_VERSION
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF')
    db.exec('PRAGMA foreign_keys = ON')
  }
  db.exec(`PRAGMA user_version = ${version}`)
}
