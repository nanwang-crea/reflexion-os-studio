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
  retry_of_run_id TEXT
);
CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`

/** 当前 schema 版本；递增时必须在 runMigrations 中补充对应升级路径。 */
export const LATEST_SCHEMA_VERSION = 2

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
