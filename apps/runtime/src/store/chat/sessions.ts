import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Session } from '@reflexion-os-studio/contracts'
import { DEFAULT_SESSION_TITLE, nowIso, type Row } from '../shared.js'

const USER_VISIBLE_SESSION = `NOT EXISTS (
  SELECT 1 FROM runs child_run
  WHERE child_run.session_id = sessions.id
    AND child_run.parent_run_id IS NOT NULL
)`

/** 会话领域：项目内会话与独立会话；内部子 Agent 会话不进入用户列表。 */
export class SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * projectId 语义：string → 该项目下的会话；null → 独立会话；undefined → 全部会话。
   */
  list(projectId?: string | null): Session[] {
    if (projectId === null) {
      return this.db
        .prepare(
          `SELECT * FROM sessions WHERE project_id IS NULL AND ${USER_VISIBLE_SESSION} ORDER BY updated_at DESC`,
        )
        .all()
        .map((row) => this.toSession(row as Row))
    }
    if (projectId !== undefined) {
      return this.db
        .prepare(
          `SELECT * FROM sessions WHERE project_id = ? AND ${USER_VISIBLE_SESSION} ORDER BY updated_at DESC`,
        )
        .all(projectId)
        .map((row) => this.toSession(row as Row))
    }
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE ${USER_VISIBLE_SESSION} ORDER BY updated_at DESC`,
      )
      .all()
      .map((row) => this.toSession(row as Row))
  }

  create(
    projectId: string | null,
    title?: string,
    gitBranch: string | null = null,
  ): Session {
    const session: Session = {
      id: randomUUID(),
      projectId,
      gitBranch,
      title: title ?? DEFAULT_SESSION_TITLE,
      status: 'active',
      executionMode: 'execute',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.db
      .prepare(
        'INSERT INTO sessions (id, project_id, git_branch, title, status, execution_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        session.id,
        session.projectId,
        session.gitBranch,
        session.title,
        session.status,
        session.executionMode,
        session.createdAt,
        session.updatedAt,
      )
    return session
  }

  get(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? this.toSession(row as Row) : null
  }

  /** 仅改标题、不动 updated_at：重命名不改变会话在时间分组中的位置。 */
  rename(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  }

  touch(id: string): void {
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(nowIso(), id)
  }

  setExecutionMode(id: string, mode: Session['executionMode']): Session {
    this.db
      .prepare('UPDATE sessions SET execution_mode = ? WHERE id = ?')
      .run(mode, id)
    const session = this.get(id)
    if (!session) throw new Error(`session not found: ${id}`)
    return session
  }

  /** 删除用户会话及其内部子会话；消息、Run 与委派由外键级联删除。 */
  delete(id: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM sessions
         WHERE id = ? OR id IN (
           SELECT child_run.session_id
           FROM runs child_run
           JOIN runs parent_run ON parent_run.id = child_run.parent_run_id
           WHERE parent_run.session_id = ?
         )`,
      )
      .run(id, id)
    return Number(result.changes) > 0
  }

  private toSession(row: Row): Session {
    return {
      id: String(row.id),
      projectId: row.project_id == null ? null : String(row.project_id),
      gitBranch:
        row.git_branch == null || row.git_branch === ''
          ? null
          : String(row.git_branch),
      title: String(row.title),
      status: row.status === 'archived' ? 'archived' : 'active',
      executionMode: row.execution_mode === 'plan' ? 'plan' : 'execute',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}
