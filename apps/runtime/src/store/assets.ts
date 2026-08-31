import type { DatabaseSync } from 'node:sqlite'
import type { AssetRef } from '@reflexion-os-studio/contracts'

interface AssetRow {
  id: string
  project_id: string
  run_id: string | null
  node_run_id: string | null
  file_name: string
  kind: string
  mime_type: string
  size: number
  hash: string
  uri: string
  created_by: string
  preview_status: string
  metadata_json: string
  created_at: string
}

function toAsset(row: AssetRow): AssetRef {
  return {
    assetId: row.id,
    projectId: row.project_id,
    uri: row.uri,
    kind: row.kind as AssetRef['kind'],
    mimeType: row.mime_type,
    size: row.size,
    hash: row.hash,
    fileName: row.file_name,
    runId: row.run_id,
    nodeRunId: row.node_run_id,
    createdBy: row.created_by as AssetRef['createdBy'],
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    preview: row.preview_status as AssetRef['preview'],
  }
}

/**
 * Asset 元数据存储：内容文件在 Asset Store（assets/<projectId>/<id>），
 * 本领域只读写引用与元数据，不触碰内容目录。
 */
export class AssetStore {
  constructor(private readonly db: DatabaseSync) {}

  create(asset: AssetRef): AssetRef {
    this.db
      .prepare(
        `INSERT INTO assets (
          id, project_id, run_id, node_run_id, file_name, kind, mime_type,
          size, hash, uri, created_by, preview_status, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        asset.assetId,
        asset.projectId,
        asset.runId,
        asset.nodeRunId,
        asset.fileName,
        asset.kind,
        asset.mimeType,
        asset.size,
        asset.hash,
        asset.uri,
        asset.createdBy,
        asset.preview,
        JSON.stringify(asset.metadata ?? {}),
        asset.createdAt,
      )
    return asset
  }

  /** 项目下全部 Asset，按创建时间倒序；项目删除时级联清行，内容目录由清理方处理。 */
  list(projectId: string): AssetRef[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC',
      )
      .all(projectId) as unknown as AssetRow[]
    return rows.map(toAsset)
  }

  get(assetId: string): AssetRef | null {
    const row = this.db
      .prepare('SELECT * FROM assets WHERE id = ?')
      .get(assetId) as AssetRow | undefined
    return row === undefined ? null : toAsset(row)
  }

  delete(assetId: string): boolean {
    return (
      this.db.prepare('DELETE FROM assets WHERE id = ?').run(assetId).changes >
      0
    )
  }
}
