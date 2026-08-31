import { useCallback, useEffect, useState } from 'react'
import type { AssetRef } from '@reflexion-os-studio/runtime-client'
import {
  deleteAsset,
  importAsset,
  listAssets,
  readAsset,
} from '../../api/assets'
import { RefreshIcon } from '../../ui/icons'
import { ConfirmDialog } from '../../components/ConfirmDialog'

interface AssetsPanelProps {
  projectId: string
  /** 外部请求聚焦预览的 Asset（如点击消息里的 asset:// 链接）。 */
  focusAssetId?: string | null
  onFocusConsumed?: () => void
}

interface PreviewState {
  asset: AssetRef
  text: string | null
  base64: string | null
  loading: boolean
  error: string | null
}

const KIND_LABELS: Record<AssetRef['kind'], string> = {
  image: '图片',
  text: '文本',
  audio: '音频',
  video: '视频',
  file: '文件',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Asset 面板：项目资产的导入（工作区相对路径）、列表、预览（图片/文本）、
 * 复制引用与删除。内容经 asset.* 命令获取（受控 Asset Store），
 * 仅预览与定位；下载/导出/系统应用打开属后续阶段。
 */
export function AssetsPanel(props: AssetsPanelProps): React.JSX.Element {
  const [assets, setAssets] = useState<AssetRef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importPath, setImportPath] = useState('')
  const [importing, setImporting] = useState(false)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const result = await listAssets(props.projectId)
      setAssets(result.assets)
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
    } finally {
      setLoading(false)
    }
  }, [props.projectId])

  useEffect(() => {
    setPreview(null)
    void refresh()
  }, [props.projectId, refresh])

  const openPreview = useCallback(async (asset: AssetRef): Promise<void> => {
    setPreview({
      asset,
      text: null,
      base64: null,
      loading: true,
      error: null,
    })
    try {
      const result = await readAsset(asset.assetId)
      setPreview((state) =>
        state === null || state.asset.assetId !== asset.assetId
          ? state
          : {
              asset: result.asset,
              text: result.text,
              base64: result.base64,
              loading: false,
              error: null,
            },
      )
    } catch (error_) {
      setPreview((state) =>
        state === null || state.asset.assetId !== asset.assetId
          ? state
          : {
              ...state,
              loading: false,
              error: error_ instanceof Error ? error_.message : String(error_),
            },
      )
    }
  }, [])

  // 外部聚焦请求（点击消息里的 asset:// 链接）：按 id 直接预览（不依赖列表）。
  useEffect(() => {
    const assetId = props.focusAssetId
    if (assetId === null || assetId === undefined) return
    void (async () => {
      try {
        const result = await readAsset(assetId)
        setPreview({
          asset: result.asset,
          text: result.text,
          base64: result.base64,
          loading: false,
          error: null,
        })
      } catch (error_) {
        setPreview({
          asset: {
            assetId,
            projectId: props.projectId,
            uri: `asset://${assetId}`,
            kind: 'file',
            mimeType: '',
            size: 0,
            hash: '',
            fileName: assetId,
            runId: null,
            nodeRunId: null,
            createdBy: 'user',
            createdAt: new Date().toISOString(),
            metadata: {},
            preview: 'failed',
          },
          text: null,
          base64: null,
          loading: false,
          error: error_ instanceof Error ? error_.message : String(error_),
        })
      }
    })()
    props.onFocusConsumed?.()
  }, [props.focusAssetId, props.projectId, props])

  const doImport = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault()
    if (importPath.trim() === '') return
    setImporting(true)
    setError(null)
    try {
      await importAsset(props.projectId, importPath.trim())
      setImportPath('')
      await refresh()
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
    } finally {
      setImporting(false)
    }
  }

  const copyRef = async (asset: AssetRef): Promise<void> => {
    try {
      await navigator.clipboard.writeText(
        `[${asset.fileName}](asset://${asset.assetId})`,
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // 剪贴板不可用时静默失败。
    }
  }

  const doDelete = async (): Promise<void> => {
    if (confirmId === null) return
    const id = confirmId
    setConfirmId(null)
    try {
      await deleteAsset(id)
      if (preview?.asset.assetId === id) setPreview(null)
      await refresh()
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
    }
  }

  if (preview !== null) {
    return (
      <div className="git-diff">
        <header className="git-diff-head">
          <button
            className="ghost"
            onClick={() => setPreview(null)}
            aria-label="返回资产列表"
            title="返回资产列表"
          >
            ←
          </button>
          <span className="git-diff-path" title={preview.asset.fileName}>
            {preview.asset.fileName}
          </span>
          <span className="git-badge">{KIND_LABELS[preview.asset.kind]}</span>
          <button className="ghost" onClick={() => void copyRef(preview.asset)}>
            {copied ? '已复制' : '复制引用'}
          </button>
        </header>
        <div className="asset-preview">
          {preview.loading ? (
            <div className="asset-hint">加载中…</div>
          ) : preview.error !== null ? (
            <div className="asset-hint asset-hint-error">{preview.error}</div>
          ) : preview.base64 !== null ? (
            <img
              className="asset-image"
              src={`data:${preview.asset.mimeType};base64,${preview.base64}`}
              alt={preview.asset.fileName}
            />
          ) : preview.text !== null ? (
            <pre className="asset-text">{preview.text}</pre>
          ) : (
            <div className="asset-hint">
              当前类型（{KIND_LABELS[preview.asset.kind]}）暂不支持预览。
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="git-changes">
      <div className="file-tree-bar">
        <span>资产{assets.length > 0 ? `（${assets.length}）` : ''}</span>
        <button
          className="ghost"
          title="刷新资产列表"
          onClick={() => void refresh()}
        >
          <RefreshIcon />
        </button>
      </div>
      <form className="asset-import" onSubmit={(event) => void doImport(event)}>
        <input
          value={importPath}
          onChange={(event) => setImportPath(event.target.value)}
          placeholder="工作区相对路径，如 src/app.ts"
          title="导入工作区文件为资产"
        />
        <button className="ghost" disabled={importing}>
          {importing ? '导入中…' : '导入'}
        </button>
      </form>
      {error !== null && (
        <div className="asset-hint asset-hint-error">{error}</div>
      )}
      {loading ? (
        <div className="asset-hint">加载中…</div>
      ) : assets.length === 0 ? (
        <div className="asset-hint">还没有资产，导入一个文件试试。</div>
      ) : (
        <ul className="git-list">
          {assets.map((asset) => (
            <li key={asset.assetId} className="asset-row">
              <button
                type="button"
                className="git-row"
                onClick={() => void openPreview(asset)}
                title={`${asset.fileName} · ${formatBytes(asset.size)} · ${asset.hash.slice(0, 8)}`}
              >
                <span className="git-badge">{KIND_LABELS[asset.kind]}</span>
                <span className="git-path">{asset.fileName}</span>
                <span className="git-size">{formatBytes(asset.size)}</span>
              </button>
              <button
                type="button"
                className="ghost asset-delete"
                title="删除资产"
                aria-label={`删除 ${asset.fileName}`}
                onClick={() => setConfirmId(asset.assetId)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        state={
          confirmId === null
            ? null
            : {
                title: '删除资产',
                message: '删除后该资产内容与引用不可恢复，确定删除？',
                confirmLabel: '删除',
                cancelLabel: '取消',
                danger: true,
              }
        }
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  )
}
