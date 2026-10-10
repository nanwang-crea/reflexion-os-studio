import type { DatabaseSync } from 'node:sqlite'

const SESSIONS_TABLE_V1 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  git_branch TEXT,
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

function tableColumns(db: DatabaseSync, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
    name: string
    notnull: number | bigint
  }[]
}
export function migrateEarlySchema(db: DatabaseSync, version: number): void {
  if (version < 1) {
    const sessionsLegacy = tableColumns(db, 'sessions').some(
      (column) => column.name === 'project_id' && Number(column.notnull) === 1,
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
      db.exec('ALTER TABLE provider_profiles ADD COLUMN context_window INTEGER')
    }
  }
  if (version < 10) {
    if (
      !tableColumns(db, 'provider_profiles').some(
        (column) => column.name === 'context_budget',
      )
    ) {
      db.exec('ALTER TABLE provider_profiles ADD COLUMN context_budget INTEGER')
    }
  }
}
