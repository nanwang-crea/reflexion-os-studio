import { useEffect, useRef, useState } from 'react'
import type { GitCommitFile, GitLogEntry } from '../../api/workspace'
import { copyTextToClipboard } from '../../lib/clipboard'
import { showToast } from '../../components/Toast'
import { formatRelativeTime } from '../../lib/git-time'
import { STATUS_LABELS } from './GitChangeList'

interface GitHistoryRowProps {
  commit: GitLogEntry
  busy: boolean
  menuOpen: boolean
  expanded: boolean
  /** undefined = 文件列表尚未加载完成。 */
  files: GitCommitFile[] | undefined
  formOpen: boolean
  onToggle: (hash: string) => void
  onMenuToggle: (hash: string) => void
  /** 外点/Escape 关闭菜单（同一时刻至多一个菜单展开，父层收敛状态）。 */
  onMenuClose: () => void
  onOpenForm: (hash: string) => void
  onCheckout: (hash: string) => void
  /** 基于该提交建分支（守卫与刷新由父层承担）。 */
  onBranchCreate: (hash: string, name: string, checkout: boolean) => void
  onOpenFile: (hash: string, file: GitCommitFile) => void
}

/** 历史面板单行：subject + 元信息 + ⋯ 菜单 + 内联建分支表单 + 展开的改动文件。 */
export function GitHistoryRow(props: GitHistoryRowProps): React.JSX.Element {
  const { commit, menuOpen, onMenuClose } = props
  const [branchName, setBranchName] = useState('')
  const [branchCheckout, setBranchCheckout] = useState(true)
  const entryRef = useRef<HTMLDivElement | null>(null)
  // 菜单外点/Escape 关闭（BranchPicker 同款，自含在本行 entry 上）。
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!entryRef.current?.contains(event.target as Node)) {
        onMenuClose()
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onMenuClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen, onMenuClose])

  const create = (): void => {
    const name = branchName.trim()
    if (name === '') return
    props.onBranchCreate(commit.hash, name, branchCheckout)
  }

  const copyHash = (): void => {
    onMenuClose()
    void copyTextToClipboard(commit.hash).then((ok) =>
      showToast(
        ok ? '已复制提交哈希到剪贴板' : '复制失败，请重试',
        ok ? 'success' : 'error',
      ),
    )
  }

  return (
    <li className="git-hist-item">
      <div className="git-hist-entry" ref={entryRef}>
        <button
          type="button"
          className="git-hist-row"
          title={commit.subject}
          onClick={() => props.onToggle(commit.hash)}
        >
          <span className="git-hist-subject">
            {commit.isMerge && (
              <span className="git-hist-merge" title="与第一父对比">
                ⊕ 合并
              </span>
            )}
            <span className="git-hist-subject-text">{commit.subject}</span>
          </span>
          <span className="git-hist-meta">
            {commit.authorName} ·{' '}
            {formatRelativeTime(commit.timestampMs, Date.now())} ·{' '}
            {commit.shortHash}
          </span>
        </button>
        <button
          type="button"
          className="git-row-action"
          disabled={props.busy}
          title="更多操作"
          aria-label="更多操作"
          onClick={() => props.onMenuToggle(commit.hash)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="git-branch-menu git-hist-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="git-branch-item"
              onClick={copyHash}
            >
              复制哈希
            </button>
            <button
              type="button"
              role="menuitem"
              className="git-branch-item"
              title="基于该提交创建新分支"
              onClick={() => props.onOpenForm(commit.hash)}
            >
              基于此建分支…
            </button>
            <button
              type="button"
              role="menuitem"
              className="git-branch-item"
              disabled={props.busy}
              title="进入分离头指针（工作树切换到该提交快照）"
              onClick={() => props.onCheckout(commit.hash)}
            >
              切换到该提交
            </button>
          </div>
        )}
      </div>
      {props.formOpen && (
        <div className="git-branch-create git-hist-form">
          <input
            className="git-branch-input"
            placeholder="新分支名称"
            value={branchName}
            autoFocus
            disabled={props.busy}
            onChange={(event) => setBranchName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') create()
            }}
          />
          <div className="git-branch-create-actions">
            <label className="git-branch-checkout">
              <input
                type="checkbox"
                checked={branchCheckout}
                disabled={props.busy}
                onChange={(event) => setBranchCheckout(event.target.checked)}
              />
              创建并切换
            </label>
            <button
              type="button"
              className="ghost"
              disabled={branchName.trim() === '' || props.busy}
              onClick={create}
            >
              创建
            </button>
          </div>
        </div>
      )}
      {props.expanded && (
        <div className="git-hist-files">
          {commit.isMerge && (
            <div className="git-hint">合并提交：改动文件均对第一父。</div>
          )}
          {props.files === undefined ? (
            <div className="git-hint">加载文件列表…</div>
          ) : (
            props.files.map((file) => (
              <button
                key={`${file.path}:${file.oldPath ?? ''}`}
                type="button"
                className="git-row git-hist-file"
                title={`查看 ${file.path} 在该提交中的差异`}
                onClick={() => props.onOpenFile(commit.hash, file)}
              >
                <span className={`git-badge git-badge-${file.status}`}>
                  {STATUS_LABELS[file.status]}
                </span>
                <span className="git-path">{file.path}</span>
                {file.oldPath !== undefined && (
                  <span className="git-old-path">{file.oldPath} →</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </li>
  )
}
