import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Session } from '@reflexion-os-studio/contracts'
import { DEFAULT_SESSION_TITLE, nowIso, type Row } from './shared.js'

/** 会话领域：项目内会话与独立会话（project_id 为空）。 */
export class SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * projectId 语义：string → 该项目下的会话；null → 独立会话；undefined → 全部会话。
   */
  list(projectId?: string | null): Session[] {
    if (projectId === null) {
      return this.db
        .prepare(
          'SELECT * FROM sessions WHERE project_id IS NULL ORDER BY updated_at DESC',
        )
        .all()
        .map((row) => this.toSession(row as Row))
    }
    if (projectId !== undefined) {
      return this.db
        .prepare(
          'SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC',
        )
        .all(projectId)
        .map((row) => this.toSession(row as Row))
    }
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
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
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.db
      .prepare(
        'INSERT INTO sessions (id, project_id, git_branch, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        session.id,
        session.projectId,
        session.gitBranch,
        session.title,
        session.status,
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

  /** 删除会话；消息与 Run 由外键级联删除。返回是否确实删除了行。 */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
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
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}
