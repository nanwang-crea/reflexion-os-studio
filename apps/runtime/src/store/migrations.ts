import { migrateEarlySchema } from './migrations/early-schema.js'
import { migrateImageAssets } from './migrations/image-assets.js'
// 版本化迁移：user_version 推进、旧库重建。
// 迁移涉及 SQLite 无法直接改列约束的表，需在 foreign_keys=OFF +
// legacy_alter_table=ON 的事务内重建，任一步失败整体回滚。
// schema DDL 与版本号定义见 schema.ts。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SecretStore } from '../secrets.js'
import { LATEST_SCHEMA_VERSION } from './schema.js'
import { nowIso } from './shared.js'

const MESSAGES_TABLE_V22 = `
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  parts_json TEXT NOT NULL DEFAULT '[]',
  reasoning TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
)`

const DELEGATIONS_TABLE_V33 = `
CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  root_run_id TEXT,
  parent_agent_id TEXT,
  agent_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  child_run_id TEXT,
  child_session_id TEXT,
  execution_json TEXT,
  instance_json TEXT,
  result TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
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
 *          无历史数据回填；升级只推进版本号）。该组表已于 v23 删除。
 * v5 → v6：runs 增加 skill_id 列（Skill 激活来源记录；加列可直接 ALTER TABLE）。
 * v12 → v13：assets 表（Phase 1B Asset Store；全新表，由 SCHEMA 创建，升级只推进版本号）。
 * v15 → v16：mcp_servers.env_json 明文 {key,value} → {key,secretRef}。旧版本把 MCP
 *          环境变量明文直接存进 env_json（Secret Store 化之前），升级时逐条把 value
 *          迁入 Secret Store 并以 secretRef 替换；任一步失败回滚整库并清除已写入的
 *          密钥引用，避免明文残留与孤儿密钥。
 * v21 → v22：messages.run_id 补外键（runs.id，ON DELETE SET NULL），消除 Run
 *          消失后消息仍指向它的幽灵引用；消息本体属会话历史（跟随 session 级联），
 *          不随 Run 删除。升级时先把悬空 run_id 置空（防御性，正常库为空集），
 *          再重建 messages 表；复制按 (created_at, rowid) 排序保持插入序。
 * v22 → v23：删除 SQLite 记忆链路——memories / memories_fts / memory_jobs
 *          整体 drop（文件即记忆 V2，真相源迁 MEMORY.md，不做数据搬迁）。
 * v24 → v25：新增 plugins 表（由 SCHEMA 创建），无历史数据回填。
 * v25 → v26：plugins 增加 manifest_json；旧记录由启动重扫按安装目录回填。
 * v27 → v28：delegations 增加父 Agent、子 Session 与版本化执行快照。
 * v28 → v29：sessions 增加 execution_mode，默认 execute。
 * v29 → v30：新增 user_interactions 表（由 SCHEMA 创建），持久化待回答问题。
 * v30 → v31：Agent Policy、Delegation 根 Run 与结构化结果。
 * v31 → v32：新增 turn_executions 表（由 SCHEMA 创建），作为统一恢复检查点。
 * v32 → v33：Agent 模板来源、动态实例快照与 mutation receipts。
 * v33 → v34：Run 持久化用户显式选择的默认子 Agent 模板。
 * v34 → v35：TurnExecution 增加版本化 Runtime 状态（首批持久化文件读取凭据）。
 * v35 → v36：plugins 增加 global/project 作用域和可选 project_id。
 * v36 → v37：provider_profiles 增加附加请求头 JSON。
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
    migrateEarlySchema(db, version)
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
    // 创建，升级只推进版本号；不回填历史 Checkpoint。memory_jobs 于 v20
    // 创建，v23 起随 SQLite 记忆链路整体删除。
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
    if (version < 22) {
      // v22：messages.run_id 补外键。先把悬空 run_id 置空（防御性，正常库为空集），
      // 再按形状检测决定是否重建表（SCHEMA 新库已带 FK，不空跑）。
      db.prepare(
        'UPDATE messages SET run_id = NULL WHERE run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = messages.run_id)',
      ).run()
      const messageFks = db
        .prepare('PRAGMA foreign_key_list(messages)')
        .all() as unknown as { table: string; from: string }[]
      const hasRunFk = messageFks.some(
        (fk) => fk.table === 'runs' && fk.from === 'run_id',
      )
      if (!hasRunFk) {
        db.exec('ALTER TABLE messages RENAME TO messages_v21')
        db.exec(MESSAGES_TABLE_V22)
        // 复制按 (created_at, rowid) 排序：listBySession 依赖 rowid 作同毫秒
        // 插入序，重建后须保持既有次序不变。
        db.exec(
          `INSERT INTO messages (id, session_id, run_id, role, content, parts_json, reasoning, status, created_at, completed_at)
           SELECT id, session_id, run_id, role, content, parts_json, reasoning, status, created_at, completed_at
           FROM messages_v21 ORDER BY created_at ASC, rowid ASC`,
        )
        db.exec('DROP TABLE messages_v21')
      }
    }
    // v23（文件即记忆 V2）：删除 SQLite 记忆链路。存量 memories/FTS/
    // memory_jobs 按用户决策整体 drop——记忆真相源迁移为 MEMORY.md 文件，
    // 不做数据搬迁（自动提取的记忆本来就不具备保留价值）。
    if (version < 23) {
      db.exec('DROP TABLE IF EXISTS memories_fts')
      db.exec('DROP TABLE IF EXISTS memories')
      db.exec('DROP TABLE IF EXISTS memory_jobs')
    }
    // v24：provider_profiles 增加 api_format 列（API 协议格式）。
    // 存量记录默认为 'openai-chat'，向后兼容。
    if (version < 24) {
      if (
        !tableColumns(db, 'provider_profiles').some(
          (column) => column.name === 'api_format',
        )
      ) {
        db.exec(
          "ALTER TABLE provider_profiles ADD COLUMN api_format TEXT NOT NULL DEFAULT 'openai-chat'",
        )
      }
    }
    // v25：plugins 是纯新增表，由 SCHEMA CREATE TABLE IF NOT EXISTS 覆盖。
    if (
      version < 26 &&
      !tableColumns(db, 'plugins').some(
        (column) => column.name === 'manifest_json',
      )
    ) {
      db.exec(
        "ALTER TABLE plugins ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '{}'",
      )
    }
    if (version < 27) {
      // v27：Phase 3A 正式开放。旧版本的 false 是读取层强制隔离值，
      // 当时 UI 也无法编辑，不代表用户选择；升级时一次性切换为启用。
      const row = db
        .prepare('SELECT settings_json FROM agent_settings WHERE id = 1')
        .get() as { settings_json: string } | undefined
      if (row) {
        try {
          const settings = JSON.parse(row.settings_json) as Record<
            string,
            unknown
          >
          if (
            settings &&
            typeof settings === 'object' &&
            !Array.isArray(settings)
          ) {
            settings.enableChildRuns = true
            db.prepare(
              'UPDATE agent_settings SET settings_json = ?, updated_at = ? WHERE id = 1',
            ).run(JSON.stringify(settings), nowIso())
          }
        } catch {
          // 非法 JSON 由 AgentSettingsStore 安全回退到 v27 默认值。
        }
      }
    }
    if (version < 28) {
      const delegationColumns = tableColumns(db, 'delegations').map(
        (column) => column.name,
      )
      if (!delegationColumns.includes('parent_agent_id')) {
        db.exec('ALTER TABLE delegations ADD COLUMN parent_agent_id TEXT')
      }
      if (!delegationColumns.includes('child_session_id')) {
        db.exec('ALTER TABLE delegations ADD COLUMN child_session_id TEXT')
      }
      if (!delegationColumns.includes('execution_json')) {
        db.exec('ALTER TABLE delegations ADD COLUMN execution_json TEXT')
      }
      db.exec(
        `UPDATE delegations
         SET child_session_id = (
           SELECT runs.session_id FROM runs
           WHERE runs.id = delegations.child_run_id
         )
         WHERE child_session_id IS NULL AND child_run_id IS NOT NULL`,
      )
      db.exec(
        `UPDATE delegations
         SET parent_agent_id = (
           SELECT runs.agent_id FROM runs
           WHERE runs.id = delegations.parent_run_id
         )
         WHERE parent_agent_id IS NULL`,
      )
    }
    if (
      version < 29 &&
      !tableColumns(db, 'sessions').some(
        (column) => column.name === 'execution_mode',
      )
    ) {
      db.exec(
        "ALTER TABLE sessions ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'execute'",
      )
    }
    if (version < 31) {
      const agentColumns = tableColumns(db, 'agents').map(
        (column) => column.name,
      )
      if (!agentColumns.includes('policy_json')) {
        db.exec(
          `ALTER TABLE agents ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{"version":1,"permissionCeiling":"workspace-read","allowedTools":["get_current_time","web.fetch","skill.use","file.read","file.list","file.glob","file.grep"],"canDelegate":true}'`,
        )
      }
      const delegationColumns = tableColumns(db, 'delegations').map(
        (column) => column.name,
      )
      if (!delegationColumns.includes('root_run_id')) {
        db.exec('ALTER TABLE delegations ADD COLUMN root_run_id TEXT')
      }
      if (!delegationColumns.includes('result_json')) {
        db.exec('ALTER TABLE delegations ADD COLUMN result_json TEXT')
      }
      db.exec(`
        WITH RECURSIVE delegation_roots(id, child_run_id, root_run_id) AS (
          SELECT d.id, d.child_run_id, d.parent_run_id
          FROM delegations d
          WHERE NOT EXISTS (
            SELECT 1 FROM delegations parent
            WHERE parent.child_run_id = d.parent_run_id
          )
          UNION ALL
          SELECT child.id, child.child_run_id, roots.root_run_id
          FROM delegation_roots roots
          JOIN delegations child ON child.parent_run_id = roots.child_run_id
        )
        UPDATE delegations
        SET root_run_id = (
          SELECT roots.root_run_id FROM delegation_roots roots
          WHERE roots.id = delegations.id
        )
        WHERE root_run_id IS NULL
      `)
    }
    if (version < 33) {
      const agentColumns = tableColumns(db, 'agents').map(
        (column) => column.name,
      )
      if (!agentColumns.includes('source')) {
        db.exec(
          "ALTER TABLE agents ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin'",
        )
      }
      if (!agentColumns.includes('builtin')) {
        db.exec(
          'ALTER TABLE agents ADD COLUMN builtin INTEGER NOT NULL DEFAULT 1',
        )
      }
      db.exec('ALTER TABLE delegations RENAME TO delegations_v32')
      db.exec(DELEGATIONS_TABLE_V33)
      db.exec(`INSERT INTO delegations (
        id, session_id, parent_run_id, root_run_id, parent_agent_id, agent_id,
        task, status, child_run_id, child_session_id, execution_json,
        instance_json, result, result_json, error, created_at, updated_at, completed_at
      ) SELECT id, session_id, parent_run_id, root_run_id, parent_agent_id, agent_id,
        task, status, child_run_id, child_session_id, execution_json,
        NULL, result, result_json, error, created_at, updated_at, completed_at
        FROM delegations_v32`)
      db.exec('DROP TABLE delegations_v32')
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_delegations_session ON delegations(session_id, created_at)',
      )
    }
    if (
      version < 34 &&
      !tableColumns(db, 'runs').some(
        (column) => column.name === 'agent_template_id',
      )
    ) {
      db.exec('ALTER TABLE runs ADD COLUMN agent_template_id TEXT')
    }
    if (
      version < 35 &&
      !tableColumns(db, 'turn_executions').some(
        (column) => column.name === 'runtime_state_json',
      )
    ) {
      db.exec('ALTER TABLE turn_executions ADD COLUMN runtime_state_json TEXT')
    }
    if (
      version < 36 &&
      !tableColumns(db, 'plugins').some((column) => column.name === 'scope')
    ) {
      db.exec(
        "ALTER TABLE plugins ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'",
      )
      db.exec(
        'ALTER TABLE plugins ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE',
      )
    }
    if (
      version < 37 &&
      !tableColumns(db, 'provider_profiles').some(
        (column) => column.name === 'headers_json',
      )
    ) {
      db.exec(
        "ALTER TABLE provider_profiles ADD COLUMN headers_json TEXT NOT NULL DEFAULT '[]'",
      )
    }
    if (version < 39) migrateImageAssets(db)
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
