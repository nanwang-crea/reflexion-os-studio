import { useCallback, useEffect, useState } from 'react'
import type { GitChangeEntry } from '@reflexion-os-studio/runtime-client'
import { gitDiff, gitStatus } from '../../api/workspace'
import { RefreshIcon } from '../../ui/icons'

interface GitChangesProps {
  projectId: string
  systemReady: boolean
  /** 点击"打开文件"时把变更文件交给查看器定位。 */
  onOpenFile: (path: string) => void
}

interface DiffState {
  path: string
  staged: boolean
  diff: string
  truncated: boolean
  loading: boolean
  error: string | null
}

const STATUS_LABELS: Record<GitChangeEntry['status'], string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  untracked: '未跟踪',
  conflicted: '冲突',
}

/**
 * Git 变更面（Phase 1B，只读第一阶段）：文件状态列表 + 单文件 diff 预览。
 * 统一经 workspace.git_status / workspace.git_diff 获取（Rust 侧 workspace 边界
 * 与超时兜底）；仅查看与定位，编辑/暂存/提交暂不开放。
 */
export function GitChanges(props: GitChangesProps): React.JSX.Element {
  const [repo, setRepo] = useState<boolean | null>(null)
  const [entries, setEntries] = useState<GitChangeEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<GitChangeEntry | null>(null)
  const [diff, setDiff] = useState<DiffState | null>(null)

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
    setActive(null)
    setDiff(null)
    setRepo(null)
    setEntries([])
    setLoading(true)
    void refresh()
  }, [props.projectId, props.systemReady, refresh])

  const openEntry = useCallback(
    async (entry: GitChangeEntry): Promise<void> => {
      setActive(entry)
      const staged = entry.staged && entry.status !== 'untracked'
      setDiff({
        path: entry.path,
        staged,
        diff: '',
        truncated: false,
        loading: true,
        error: null,
      })
      try {
        // 先取工作树 diff；为空且索引有变更（如已 add 的文件、仅暂存的修改）
        // 时自动回退索引 diff，覆盖 "MM" 与 "A " 两类形态。
        let result = await gitDiff(props.projectId, entry.path, false)
        if (result.diff === '' && staged && result.repo && !result.truncated) {
          result = await gitDiff(props.projectId, entry.path, true)
        }
        setDiff((state) =>
          state === null || state.path !== entry.path
            ? state
            : {
                ...state,
                diff: result.diff,
                truncated: result.truncated,
                loading: false,
                error: result.repo ? null : '目录不是 Git 仓库',
              },
        )
      } catch (error_) {
        setDiff((state) =>
          state === null || state.path !== entry.path
            ? state
            : {
                ...state,
                loading: false,
                error:
                  error_ instanceof Error ? error_.message : String(error_),
              },
        )
      }
    },
    [props.projectId],
  )

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
  if (active !== null && diff !== null) {
    return (
      <div className="git-diff">
        <header className="git-diff-head">
          <button
            className="ghost"
            onClick={() => {
              setActive(null)
              setDiff(null)
            }}
            aria-label="返回变更列表"
            title="返回变更列表"
          >
            ←
          </button>
          <span className="git-diff-path" title={active.path}>
            {active.path}
          </span>
          <span className={`git-badge git-badge-${active.status}`}>
            {STATUS_LABELS[active.status]}
          </span>
          <button
            className="ghost"
            onClick={() => props.onOpenFile(active.path)}
          >
            打开文件
          </button>
        </header>
        <div className="git-diff-body">
          {diff.loading ? (
            <div className="git-hint">加载 diff…</div>
          ) : diff.error !== null ? (
            <div className="git-hint git-hint-error">{diff.error}</div>
          ) : diff.diff === '' ? (
            <div className="git-hint">
              {active.status === 'untracked'
                ? '未跟踪文件：打开文件查看全部内容。'
                : '当前没有可显示的差异。'}
            </div>
          ) : (
            <pre className="git-diff-text">
              {diff.diff}
              {diff.truncated && (
                <div className="git-hint">（diff 过大，已截断显示）</div>
              )}
            </pre>
          )}
        </div>
      </div>
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
                onClick={() => void openEntry(entry)}
                title={entry.path}
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
