import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Project } from '@reflexion-os-studio/contracts'
import { nowIso, type Row } from './shared.js'

/** 项目领域：项目即本地文件夹的元数据。 */
export class ProjectStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all()
      .map((row) => this.toProject(row as Row))
  }

  findByFolderPath(folderPath: string): Project | null {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE folder_path = ?')
      .get(folderPath)
    return row ? this.toProject(row as Row) : null
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    return row ? this.toProject(row as Row) : null
  }

  create(input: { name: string; folderPath: string }): Project {
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

  /** 删除项目；外键级联其下会话（会话再级联消息与 Run）。 */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }

  private toProject(row: Row): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      folderPath: String(row.folder_path ?? ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}
