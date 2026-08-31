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

interface WorkspacePanelProps {
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
  failed: '失败',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 对话右侧的工作区面板（Codex/ChatGPT 桌面式）：索引状态 + 文件树，
 * 点击文件在面板内预览；索引器纯 TS 异步运行，文件访问经 Rust 侧
 * workspace 边界校验。未选项目时提示去左侧选择。
 */
export function WorkspacePanel(props: WorkspacePanelProps): React.JSX.Element {
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
    // 进度事件约 400ms 一次：状态查询防抖，避免持续打 runtime。
    let timer: ReturnType<typeof setTimeout> | null = null
    const unlisten = onWorkspaceIndexEvent((event) => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void refreshStatus()
      }, 300)
      if (event.type === 'workspace.index.failed') {
        setError(event.error)
      }
    })
    return () => {
      unlisten()
      if (timer !== null) clearTimeout(timer)
    }
  }, [projectId, refreshStatus])

  useEffect(() => {
    setScanning(snapshot?.status === 'scanning')
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
      <div className="workspace-panel">
        <div className="workspace-panel-empty">
          <FolderIcon />
          <p>在左侧选择项目后，可在这里浏览工作区文件与运行索引。</p>
        </div>
      </div>
    )
  }

  const status = snapshot?.status ?? 'idle'

  return (
    <div className="workspace-panel">
      <div className="workspace-head">
        <div className="workspace-title" title={project.folderPath}>
          {project.name}
        </div>
        <div className="workspace-path" title={project.folderPath}>
          {project.folderPath || '未关联文件夹'}
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
      </div>

      {error && <div className="workspace-error">{error}</div>}
      {!props.systemReady && (
        <div className="workspace-degraded">
          工具 Runtime 不可用：文件树与预览暂不可用（索引器不受影响）。
        </div>
      )}

      {activePath === null ? (
        <FileTree
          key={`${project.id}-${treeEpoch}`}
          projectId={project.id}
          systemReady={props.systemReady}
          activePath={activePath}
          onOpenFile={setActivePath}
          onRefresh={() => setTreeEpoch((epoch) => epoch + 1)}
        />
      ) : (
        <div className="workspace-preview">
          <ContentView
            key={activePath}
            projectId={project.id}
            path={activePath}
            onClose={() => setActivePath(null)}
          />
        </div>
      )}
    </div>
  )
}
