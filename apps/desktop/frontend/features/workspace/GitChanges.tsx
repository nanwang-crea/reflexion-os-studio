import { useCallback, useEffect, useState } from 'react'
import type { GitChangeEntry } from '@reflexion-os-studio/runtime-client'
import { gitStatus } from '../../api/workspace'
import { RefreshIcon } from '../../ui/icons'

interface GitChangesProps {
  projectId: string
  systemReady: boolean
  /** 点击变更文件时直接交给右侧只读文件查看器。 */
  onOpenFile: (path: string) => void
}

const STATUS_LABELS: Record<GitChangeEntry['status'], string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  untracked: '未跟踪',
  conflicted: '冲突',
}

/** Git 变更只读列表；点击文件直接在右侧多标签查看器中打开。 */
export function GitChanges(props: GitChangesProps): React.JSX.Element {
  const [repo, setRepo] = useState<boolean | null>(null)
  const [entries, setEntries] = useState<GitChangeEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!props.systemReady) return
    setLoading(true)
    setError(null)
    try {
      const result = await gitStatus(props.projectId)
      setRepo(result.repo)
      setEntries(result.entries)
      setTruncated(result.truncated)
    } catch (error_) {
      setRepo(null)
      setEntries([])
      setError(error_ instanceof Error ? error_.message : String(error_))
    } finally {
      setLoading(false)
    }
  }, [props.projectId, props.systemReady])

  useEffect(() => {
    setRepo(null)
    setEntries([])
    setLoading(true)
    void refresh()
  }, [props.projectId, props.systemReady, refresh])

  if (!props.systemReady) {
    return (
      <div className="git-hint">工具 Runtime 不可用，Git 变更暂不可用。</div>
    )
  }
  if (loading && entries.length === 0) {
    return <div className="git-hint">加载中…</div>
  }
  if (error !== null) {
    return (
      <div className="git-hint git-hint-error">
        {error}
        <button className="ghost" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    )
  }
  if (repo === false) {
    return (
      <div className="git-hint">当前工作区不是 Git 仓库（未找到 .git）。</div>
    )
  }

  return (
    <div className="git-changes">
      <div className="file-tree-bar">
        <span>Git 变更{truncated ? '（已截断）' : ''}</span>
        <button
          className="ghost"
          title="刷新变更列表"
          onClick={() => void refresh()}
        >
          <RefreshIcon />
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="git-hint">工作树干净，没有未提交的变更。</div>
      ) : (
        <ul className="git-list">
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="git-row"
                onClick={() => props.onOpenFile(entry.path)}
                title={`在右侧打开 ${entry.path}`}
              >
                <span className={`git-badge git-badge-${entry.status}`}>
                  {STATUS_LABELS[entry.status]}
                </span>
                <span className="git-path">{entry.path}</span>
                {entry.oldPath !== undefined && (
                  <span className="git-old-path">{entry.oldPath} →</span>
                )}
                {entry.staged && <span className="git-staged">已暂存</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
