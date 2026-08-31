import type { DatabaseSync } from 'node:sqlite'
import type {
  WorkspaceExtStats,
  WorkspaceIndexSnapshot,
  WorkspaceIndexStatus,
} from '@reflexion-os-studio/contracts'

interface SnapshotRow {
  project_id: string
  status: string
  version: number
  started_at: string | null
  completed_at: string | null
  stale_at: string | null
  file_count: number
  dir_count: number
  total_bytes: number
  ext_stats_json: string
  truncated: number
  error: string | null
}

function toSnapshot(row: SnapshotRow): WorkspaceIndexSnapshot {
  return {
    projectId: row.project_id,
    status: row.status as WorkspaceIndexStatus,
    version: row.version,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    staleAt: row.stale_at,
    fileCount: row.file_count,
    dirCount: row.dir_count,
    totalBytes: row.total_bytes,
    extStats: JSON.parse(row.ext_stats_json) as WorkspaceExtStats[],
    truncated: row.truncated === 1,
    error: row.error,
  }
}

/**
 * 每项目一份的 Workspace 索引快照存储。索引器只通过本域读写，
 * 不直接写 SQL；stale 由查询侧按根目录 mtime 推导，不在表中流转。
 */
export class WorkspaceIndexStore {
  constructor(private readonly db: DatabaseSync) {}

  get(projectId: string): WorkspaceIndexSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM workspace_index WHERE project_id = ?')
      .get(projectId) as SnapshotRow | undefined
    return row === undefined ? null : toSnapshot(row)
  }

  /** 全量覆盖式保存（upsert）；索引器为此表唯一写入方。 */
  upsert(snapshot: WorkspaceIndexSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO workspace_index (
          project_id, status, version, started_at, completed_at, stale_at,
          file_count, dir_count, total_bytes, ext_stats_json, truncated, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          status = excluded.status,
          version = excluded.version,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          stale_at = excluded.stale_at,
          file_count = excluded.file_count,
          dir_count = excluded.dir_count,
          total_bytes = excluded.total_bytes,
          ext_stats_json = excluded.ext_stats_json,
          truncated = excluded.truncated,
          error = excluded.error`,
      )
      .run(
        snapshot.projectId,
        snapshot.status,
        snapshot.version,
        snapshot.startedAt,
        snapshot.completedAt,
        snapshot.staleAt,
        snapshot.fileCount,
        snapshot.dirCount,
        snapshot.totalBytes,
        JSON.stringify(snapshot.extStats),
        snapshot.truncated ? 1 : 0,
        snapshot.error,
      )
  }

  /** 启动恢复：上次进程中断时遗留的 scanning 行不能冒充健康的扫描状态。 */
  recoverInterrupted(): void {
    this.db
      .prepare(
        "UPDATE workspace_index SET status = 'failed', error = '索引在运行时中断' WHERE status = 'scanning'",
      )
      .run()
  }
}
