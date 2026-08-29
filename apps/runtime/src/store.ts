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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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

export class Store {
  private readonly db: DatabaseSync

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'reflexion.db'))
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.recoverInterrupted()
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

  createProject(name: string): Project {
    const project: Project = {
      id: randomUUID(),
      name,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.db
      .prepare(
        'INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(project.id, project.name, project.createdAt, project.updatedAt)
    return project
  }

  listSessions(projectId: string): Session[] {
    return this.db
      .prepare(
        'SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC',
      )
      .all(projectId)
      .map((row) => this.toSession(row))
  }

  createSession(projectId: string, title?: string): Session {
    const session: Session = {
      id: randomUUID(),
      projectId,
      title: title ?? '新会话',
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
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private toSession(row: Record<string, unknown>): Session {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
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
