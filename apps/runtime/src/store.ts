import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Message,
  MessageRole,
  MessageStatus,
  Project,
  ProviderProfile,
  Run,
  RunStatus,
  Session,
} from '@reflexion-os-studio/contracts'

export function resolveDataDir(): string {
  return (
    process.env.REFLEXION_DATA_DIR ?? join(homedir(), '.reflexion-os-studio')
  )
}

/** 新会话默认标题；Agent 用它判断是否需要根据首条消息自动命名。 */
export const DEFAULT_SESSION_TITLE = '新对话'

const SCHEMA = `
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
  model TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
`

function nowIso(): string {
  return new Date().toISOString()
}

/** 当前 schema 版本；递增时必须在 migrate() 中补充对应升级路径。 */
const LATEST_SCHEMA_VERSION = 1

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

export class Store {
  private readonly db: DatabaseSync

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'reflexion.db'))
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.migrate()
    this.recoverInterrupted()
  }

  /**
   * v0 → v1：sessions.project_id 改为可空（独立会话），projects 增加 folder_path。
   * SQLite 无法直接改列约束，需在关闭外键 + legacy_alter_table 下重建两张表。
   */
  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as
      { user_version: number | bigint } | undefined
    if (Number(row?.user_version ?? 0) >= LATEST_SCHEMA_VERSION) return
    this.db.exec('PRAGMA foreign_keys = OFF')
    this.db.exec('PRAGMA legacy_alter_table = ON')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('ALTER TABLE sessions RENAME TO sessions_v0')
      this.db.exec(SESSIONS_TABLE_V1)
      this.db.exec(
        `INSERT INTO sessions (id, project_id, title, status, created_at, updated_at)
         SELECT id, project_id, title, status, created_at, updated_at FROM sessions_v0`,
      )
      this.db.exec('DROP TABLE sessions_v0')
      this.db.exec('ALTER TABLE projects RENAME TO projects_v0')
      this.db.exec(PROJECTS_TABLE_V1)
      this.db.exec(
        `INSERT INTO projects (id, name, folder_path, created_at, updated_at)
         SELECT id, name, '', created_at, updated_at FROM projects_v0`,
      )
      this.db.exec('DROP TABLE projects_v0')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.db.exec('PRAGMA legacy_alter_table = OFF')
      this.db.exec('PRAGMA foreign_keys = ON')
    }
    this.db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private recoverInterrupted(): void {
    const timestamp = nowIso()
    this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', completed_at = ?
         WHERE status IN ('created', 'running')`,
      )
      .run(timestamp)
    this.db
      .prepare(
        `UPDATE messages SET status = 'interrupted', completed_at = ?
         WHERE status IN ('pending', 'streaming')`,
      )
      .run(timestamp)
  }

  listProjects(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all()
      .map((row) => this.toProject(row))
  }

  findProjectByFolderPath(folderPath: string): Project | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE folder_path = ?')
      .get(folderPath)
    return row ? this.toProject(row) : null
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    return row ? this.toProject(row) : null
  }

  createProject(input: { name: string; folderPath: string }): Project {
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      folderPath: input.folderPath,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.db
      .prepare(
        'INSERT INTO projects (id, name, folder_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        project.id,
        project.name,
        project.folderPath,
        project.createdAt,
        project.updatedAt,
      )
    return project
  }

  /**
   * projectId 语义：string → 该项目下的会话；null → 独立会话；undefined → 全部会话。
   */
  listSessions(projectId?: string | null): Session[] {
    if (projectId === null) {
      return this.db
        .prepare(
          'SELECT * FROM sessions WHERE project_id IS NULL ORDER BY updated_at DESC',
        )
        .all()
        .map((row) => this.toSession(row))
    }
    if (projectId !== undefined) {
      return this.db
        .prepare(
          'SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC',
        )
        .all(projectId)
        .map((row) => this.toSession(row))
    }
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
      .all()
      .map((row) => this.toSession(row))
  }

  createSession(projectId: string | null, title?: string): Session {
    const session: Session = {
      id: randomUUID(),
      projectId,
      title: title ?? DEFAULT_SESSION_TITLE,
      status: 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.db
      .prepare(
        'INSERT INTO sessions (id, project_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        session.id,
        session.projectId,
        session.title,
        session.status,
        session.createdAt,
        session.updatedAt,
      )
    return session
  }

  updateSessionTitle(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, nowIso(), id)
  }

  touchSession(id: string): void {
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(nowIso(), id)
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? this.toSession(row) : null
  }

  getSessionMessages(sessionId: string): Message[] {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(sessionId)
      .map((row) => this.toMessage(row))
  }

  getSessionRuns(sessionId: string): Run[] {
    return this.db
      .prepare(
        'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at ASC, id ASC',
      )
      .all(sessionId)
      .map((row) => this.toRun(row))
  }

  createMessage(input: {
    sessionId: string
    runId: string | null
    role: MessageRole
    content: string
    status: MessageStatus
  }): Message {
    const message: Message = {
      id: randomUUID(),
      sessionId: input.sessionId,
      runId: input.runId,
      role: input.role,
      content: input.content,
      status: input.status,
      createdAt: nowIso(),
      completedAt: input.status === 'completed' ? nowIso() : null,
    }
    this.db
      .prepare(
        'INSERT INTO messages (id, session_id, run_id, role, content, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        message.id,
        message.sessionId,
        message.runId,
        message.role,
        message.content,
        message.status,
        message.createdAt,
        message.completedAt,
      )
    return message
  }

  finalizeMessage(id: string, content: string, status: MessageStatus): void {
    this.db
      .prepare(
        'UPDATE messages SET content = ?, status = ?, completed_at = ? WHERE id = ?',
      )
      .run(content, status, nowIso(), id)
  }

  setMessageStreaming(id: string): void {
    this.db
      .prepare("UPDATE messages SET status = 'streaming' WHERE id = ?")
      .run(id)
  }

  createRun(input: {
    sessionId: string
    providerId: string | null
    model: string | null
    retryOfRunId?: string | null
  }): Run {
    const run: Run = {
      id: randomUUID(),
      sessionId: input.sessionId,
      status: 'running',
      providerId: input.providerId,
      model: input.model,
      startedAt: nowIso(),
      completedAt: null,
      errorCode: null,
      retryOfRunId: input.retryOfRunId ?? null,
    }
    this.db
      .prepare(
        'INSERT INTO runs (id, session_id, status, provider_id, model, started_at, completed_at, error_code, retry_of_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        run.id,
        run.sessionId,
        run.status,
        run.providerId,
        run.model,
        run.startedAt,
        run.completedAt,
        run.errorCode,
        run.retryOfRunId,
      )
    return run
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    return row ? this.toRun(row) : null
  }

  finalizeRun(id: string, status: RunStatus, errorCode?: string): void {
    this.db
      .prepare(
        'UPDATE runs SET status = ?, completed_at = ?, error_code = ? WHERE id = ?',
      )
      .run(status, nowIso(), errorCode ?? null, id)
  }

  activeRunForSession(sessionId: string): Run | null {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE session_id = ? AND status IN ('created', 'running') LIMIT 1",
      )
      .get(sessionId)
    return row ? this.toRun(row) : null
  }

  listProviderProfiles(): ProviderProfile[] {
    return this.db
      .prepare('SELECT * FROM provider_profiles ORDER BY updated_at DESC')
      .all()
      .map((row) => this.toProviderProfile(row))
  }

  getEnabledProviderProfile(): ProviderProfile | null {
    const row = this.db
      .prepare(
        'SELECT * FROM provider_profiles WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 1',
      )
      .get()
    return row ? this.toProviderProfile(row) : null
  }

  upsertProviderProfile(input: {
    id?: string
    name: string
    baseUrl: string
    model: string
    secretRef: string
    enabled: boolean
  }): ProviderProfile {
    const id = input.id ?? randomUUID()
    const updatedAt = nowIso()
    this.db
      .prepare(
        `INSERT INTO provider_profiles (id, name, base_url, model, secret_ref, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           model = excluded.model,
           secret_ref = excluded.secret_ref,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.name,
        input.baseUrl,
        input.model,
        input.secretRef,
        input.enabled ? 1 : 0,
        updatedAt,
      )
    const row = this.db
      .prepare('SELECT * FROM provider_profiles WHERE id = ?')
      .get(id)
    if (!row) throw new Error(`provider profile not found after upsert: ${id}`)
    return this.toProviderProfile(row)
  }

  private toProject(row: Record<string, unknown>): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      folderPath: String(row.folder_path ?? ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private toSession(row: Record<string, unknown>): Session {
    return {
      id: String(row.id),
      projectId: row.project_id == null ? null : String(row.project_id),
      title: String(row.title),
      status: row.status === 'archived' ? 'archived' : 'active',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private toMessage(row: Record<string, unknown>): Message {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      runId: row.run_id == null ? null : String(row.run_id),
      role: String(row.role) as MessageRole,
      content: String(row.content),
      status: String(row.status) as MessageStatus,
      createdAt: String(row.created_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    }
  }

  private toRun(row: Record<string, unknown>): Run {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      status: String(row.status) as RunStatus,
      providerId: row.provider_id == null ? null : String(row.provider_id),
      model: row.model == null ? null : String(row.model),
      startedAt: row.started_at == null ? null : String(row.started_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      errorCode: row.error_code == null ? null : String(row.error_code),
      retryOfRunId:
        row.retry_of_run_id == null ? null : String(row.retry_of_run_id),
    }
  }

  private toProviderProfile(row: Record<string, unknown>): ProviderProfile {
    return {
      id: String(row.id),
      name: String(row.name),
      baseUrl: String(row.base_url),
      model: String(row.model),
      secretRef: String(row.secret_ref),
      enabled: Number(row.enabled) === 1,
      updatedAt: String(row.updated_at),
    }
  }
}
