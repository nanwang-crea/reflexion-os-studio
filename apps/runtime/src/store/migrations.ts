// 版本化迁移：user_version 推进、旧库重建。
// 迁移涉及 SQLite 无法直接改列约束的表，需在 foreign_keys=OFF +
// legacy_alter_table=ON 的事务内重建，任一步失败整体回滚。
// schema DDL 与版本号定义见 schema.ts。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SecretStore } from '../secrets.js'
import { LATEST_SCHEMA_VERSION } from './schema.js'
import { nowIso } from './shared.js'

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
 * v12 → v13：assets 表（Phase 1B Asset Store；全新表，由 SCHEMA 创建，升级只推进版本号）。
 * v15 → v16：mcp_servers.env_json 明文 {key,value} → {key,secretRef}。旧版本把 MCP
 *          环境变量明文直接存进 env_json（Secret Store 化之前），升级时逐条把 value
 *          迁入 Secret Store 并以 secretRef 替换；任一步失败回滚整库并清除已写入的
 *          密钥引用，避免明文残留与孤儿密钥。
 * 各步骤带形状检测：SCHEMA 刚建好的新库不会空跑重建。
 */
export function runMigrations(db: DatabaseSync, dir: string): void {
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
    if (version < 14) {
      // v14：sessions 增加 git_branch（项目 Git 会话绑定分支；独立会话为 NULL）。
      if (
        !tableColumns(db, 'sessions').some(
          (column) => column.name === 'git_branch',
        )
      ) {
        db.exec('ALTER TABLE sessions ADD COLUMN git_branch TEXT')
      }
    }
    if (version < 15) {
      const runColumns = tableColumns(db, 'runs').map((column) => column.name)
      if (!runColumns.includes('plan_id'))
        db.exec('ALTER TABLE runs ADD COLUMN plan_id TEXT')
      if (!runColumns.includes('plan_step_id'))
        db.exec('ALTER TABLE runs ADD COLUMN plan_step_id TEXT')
    }
    if (version < 16) {
      migrateMcpEnvSecrets(db, dir)
    }
    // v17: agents/delegations tables are additive and created by SCHEMA.
    if (version < 19) {
      const runColumns = tableColumns(db, 'runs').map((c) => c.name)
      if (!runColumns.includes('superseded_by_run_id'))
        db.exec('ALTER TABLE runs ADD COLUMN superseded_by_run_id TEXT')
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_runs_retry_of ON runs(retry_of_run_id)',
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_runs_superseded_by ON runs(superseded_by_run_id)',
      )
    }
    // v20: context_checkpoints / memory_jobs 为加法迁移，全新表由 SCHEMA
    // 创建，升级只推进版本号；不回填历史 Checkpoint，也不为历史 Run
    // 自动创建 Memory Job。
    if (version < 21) {
      // v21：Plan 移除失败态（计划是任务进度板，"失败"的只是某次 Run）。
      // 存量 failed 计划/步骤改写为 cancelled，summary/note 保留作历史记录。
      const stepUpdate = db.prepare(
        "UPDATE plan_steps SET status = 'cancelled', updated_at = ? WHERE status = 'failed'",
      )
      stepUpdate.run(nowIso())
      const planUpdate = db.prepare(
        "UPDATE plans SET status = 'cancelled', updated_at = ? WHERE status = 'failed'",
      )
      planUpdate.run(nowIso())
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

/**
 * v15 → v16：把 mcp_servers.env_json 中的旧明文 {key, value} 逐条迁入
 * Secret Store，替换为 {key, secretRef}。Secret Store 与 DB 同目录（dir）。
 * 迁移在 runMigrations 的事务内执行：任一失败由外层 ROLLBACK 回滚整库，
 * 此处同步清除已写入的密钥引用，避免明文残留或孤儿密钥。
 */
function migrateMcpEnvSecrets(db: DatabaseSync, dir: string): void {
  const rows = db.prepare('SELECT id, env_json FROM mcp_servers').all() as {
    id: string
    env_json: string | null
  }[]
  if (rows.length === 0) return
  const secretStore = new SecretStore(dir)
  const created: string[] = []
  try {
    const update = db.prepare(
      'UPDATE mcp_servers SET env_json = ?, updated_at = ? WHERE id = ?',
    )
    for (const row of rows) {
      let env: unknown[] = []
      try {
        const parsed: unknown = JSON.parse(String(row.env_json ?? '[]'))
        if (Array.isArray(parsed)) env = parsed
      } catch {
        // 非法 JSON 按空环境处理，并在迁移中规范化落库。
      }
      // 迁移后 env_json 只允许稳定的 {key, secretRef} 形态；丢弃非法条目。
      const migrated = env.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const item = entry as Record<string, unknown>
        if (typeof item.key !== 'string' || item.key.length === 0) return []
        if (typeof item.secretRef === 'string' && item.secretRef.length > 0) {
          return [{ key: item.key, secretRef: item.secretRef }]
        }
        if (typeof item.value === 'string') {
          const secretRef = `local:${randomUUID()}`
          secretStore.save(secretRef, item.value)
          created.push(secretRef)
          return [{ key: item.key, secretRef }]
        }
        return []
      })
      const canonical = JSON.stringify(migrated)
      if (canonical !== String(row.env_json ?? '[]')) {
        update.run(canonical, nowIso(), String(row.id))
      }
    }
  } catch (error) {
    // 整库回滚交给 runMigrations 外层；此处只负责回收已写出的密钥引用。
    for (const ref of created) {
      try {
        secretStore.delete(ref)
      } catch {
        // 清理失败不掩盖迁移失败的主因。
      }
    }
    throw error
  }
}
