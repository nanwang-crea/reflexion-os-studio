import { useCallback, useEffect, useState } from 'react'
import type {
  Project,
  WorkspaceIndexSnapshot,
} from '@reflexion-os-studio/runtime-client'
import {
  cancelIndex,
  getIndexStatus,
  onWorkspaceIndexEvent,
  startIndex,
} from '../../api/workspace'
import { FolderIcon, RefreshIcon } from '../../ui/icons'
import { FileTree } from './FileTree'
import { ContentView } from './ContentView'

interface WorkspaceViewProps {
  /** 当前激活项目；null 时展示占位提示。 */
  project: Project | null
  /** Rust System Runtime 可用性：文件树/查看器依赖它，索引器不依赖。 */
  systemReady: boolean
}

const STATUS_LABELS: Record<string, string> = {
  idle: '未索引',
  scanning: '扫描中',
  completed: '已索引',
  stale: '已过期',
  failed: '索引失败',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Phase 1B Workspace Surface：项目工作区的索引状态 + 文件树 + 只读查看器。
 * 索引器纯 TS 异步运行（不依赖 Rust）；文件树/查看器经 Rust System Runtime
 * 按需加载（Rust 侧强制 workspace 边界）。
 */
export function WorkspaceView(props: WorkspaceViewProps): React.JSX.Element {
  const project = props.project
  const projectId = project?.id ?? null
  const [snapshot, setSnapshot] = useState<WorkspaceIndexSnapshot | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [treeEpoch, setTreeEpoch] = useState(0)

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (projectId === null) {
      setSnapshot(null)
      return
    }
    try {
      const status = await getIndexStatus(projectId)
      setSnapshot(status.snapshot)
      setError(null)
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
    }
  }, [projectId])

  useEffect(() => {
    setSnapshot(null)
    setActivePath(null)
    setError(null)
    void refreshStatus()
  }, [projectId, refreshStatus])

  useEffect(() => {
    if (projectId === null) return
    return onWorkspaceIndexEvent((event) => {
      // 进度/完成/失败都重查状态（含 UI 与事件计数同步）。
      void refreshStatus()
      if (event.type === 'workspace.index.failed') {
        setError(event.error)
      }
    })
  }, [projectId, refreshStatus])

  useEffect(() => {
    const scanningNow = snapshot?.status === 'scanning'
    setScanning(scanningNow)
  }, [snapshot?.status])

  const onIndex = async (): Promise<void> => {
    if (projectId === null) return
    try {
      await startIndex(projectId)
      setScanning(true)
      void refreshStatus()
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
    }
  }

  const onCancel = async (): Promise<void> => {
    if (projectId === null) return
    try {
      await cancelIndex(projectId)
      void refreshStatus()
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
    }
  }

  if (project === null) {
    return (
      <div className="workspace">
        <div className="workspace-empty">
          <FolderIcon />
          <p>先在左侧选择一个项目，在工作区页面浏览与查看项目文件。</p>
        </div>
      </div>
    )
  }

  const status = snapshot?.status ?? 'idle'

  return (
    <div className="workspace">
      <div className="workspace-panel">
        <div className="workspace-head">
          <div className="workspace-title" title={project.folderPath}>
            {project.name}
          </div>
          <div className="workspace-path" title={project.folderPath}>
            {project.folderPath || '未关联文件夹'}
          </div>
        </div>

        <div className="workspace-index">
          <span className={`index-chip index-${status}`}>
            {STATUS_LABELS[status] ?? status}
          </span>
          {snapshot !== null && snapshot.status !== 'idle' && (
            <span className="index-stats">
              {snapshot.fileCount} 文件 · {snapshot.dirCount} 目录 ·{' '}
              {formatBytes(snapshot.totalBytes)}
              {snapshot.truncated ? '（已截断）' : ''}
              {snapshot.extStats.length > 0 &&
                ` · ${snapshot.extStats
                  .slice(0, 3)
                  .map((entry) => `${entry.ext} ${entry.files}`)
                  .join(' · ')}`}
            </span>
          )}
          <span className="bar-spacer" />
          {scanning ? (
            <>
              <button className="ghost" onClick={() => void onCancel()}>
                停止
              </button>
              <button
                className="ghost"
                title="重新索引"
                onClick={() => void onIndex()}
              >
                <RefreshIcon />
              </button>
            </>
          ) : (
            <button className="ghost" onClick={() => void onIndex()}>
              {snapshot === null ? '开始索引' : '重新索引'}
            </button>
          )}
        </div>

        {error && <div className="workspace-error">{error}</div>}
        {!props.systemReady && (
          <div className="workspace-degraded">
            系统工具 Runtime 不可用：文件树与查看器暂不可用（索引器不受影响）。
          </div>
        )}
        {snapshot?.status === 'failed' && snapshot.error !== null && (
          <div className="workspace-error">{snapshot.error}</div>
        )}

        <FileTree
          key={`${project.id}-${treeEpoch}`}
          projectId={project.id}
          systemReady={props.systemReady}
          activePath={activePath}
          onOpenFile={setActivePath}
          onRefresh={() => setTreeEpoch((epoch) => epoch + 1)}
        />
      </div>
      <div className="workspace-viewer">
        {activePath === null ? (
          <div className="workspace-viewer-empty">
            <p>点击左侧文件查看内容</p>
          </div>
        ) : (
          <ContentView
            key={activePath}
            projectId={project.id}
            path={activePath}
            onClose={() => setActivePath(null)}
          />
        )}
      </div>
    </div>
  )
}
