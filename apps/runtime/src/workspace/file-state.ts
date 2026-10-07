import { randomUUID } from 'node:crypto'
import type { FileRevision } from '@reflexion-os-studio/contracts'

interface WorkspaceFileRecord {
  workspaceRoot: string
  path: string
  revision: FileRevision
  complete: boolean
}

/** 不可变读取快照；其他读取不会推进旧编辑器的版本。容量有界，失效须重读。 */
export class WorkspaceFileState {
  private readonly entries = new Map<string, WorkspaceFileRecord>()

  record(
    workspaceRoot: string,
    path: string,
    rec: Pick<WorkspaceFileRecord, 'revision' | 'complete'>,
  ): string {
    const token = randomUUID()
    this.entries.set(token, { workspaceRoot, path, ...rec })
    if (this.entries.size > 1024) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    return token
  }

  entry(
    workspaceRoot: string,
    path: string,
    token: string,
  ): WorkspaceFileRecord | undefined {
    const record = this.entries.get(token)
    return record?.workspaceRoot === workspaceRoot && record.path === path
      ? record
      : undefined
  }
}

export const workspaceFileState = new WorkspaceFileState()
