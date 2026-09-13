import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitRemote } from '../../api/workspace'
import { GitRemotesSection } from './GitRemotesSection'

interface BranchPickerProps {
  branch: string | null
  ahead: number | null
  behind: number | null
  branches: string[]
  /** 远程分支全名（origin/x）；点击后预填建分支表单。 */
  remoteBranches: string[]
  remotes: GitRemote[]
  busy: boolean
  /** 切换分支；守卫与错误处理由父层承担。 */
  onSwitch: (name: string) => void
  /** 新建分支；checkout=true 时同时切换过去；startRef=commit 哈希或 remote/branch。 */
  onCreate: (name: string, checkout: boolean, startRef?: string) => void
  onRemoteAdd: (name: string, url: string) => Promise<boolean>
  onRemoteRemove: (name: string) => Promise<boolean>
  /** 展开菜单时请求父层刷新分支/远端列表。 */
  onRefresh: () => void
}

/** 分支芯片（当前分支 + ahead/behind 计数）与下拉菜单（本地/远程分支切换 + 新建分支 + 远端管理）。 */
export function BranchPicker(props: BranchPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [checkout, setCheckout] = useState(true)
  const [startRef, setStartRef] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const closeMenu = useCallback((): void => {
    setOpen(false)
    setNewName('')
    setStartRef(null)
    // 「创建并切换」恢复默认勾选：勾选状态不应跨菜单开关泄漏到下一次创建。
    setCheckout(true)
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, closeMenu])

  const toggle = (): void => {
    const next = !open
    if (!next) {
      closeMenu()
      return
    }
    setOpen(true)
    props.onRefresh()
  }

  const trimmed = newName.trim()

  const create = (): void => {
    if (trimmed === '') return
    props.onCreate(trimmed, checkout, startRef ?? undefined)
    closeMenu()
  }

  /** 远程分支 → 本地名取首个 '/' 之后段；startRef 用完整远程引用。 */
  const prefillFromRemote = (ref: string): void => {
    const slash = ref.indexOf('/')
    setNewName(slash >= 0 ? ref.slice(slash + 1) : ref)
    setStartRef(ref)
    setCheckout(true)
    inputRef.current?.focus()
  }

  return (
    <div className="git-branch-picker" ref={rootRef}>
      <button
        type="button"
        className="git-branch-chip"
        disabled={props.busy}
        aria-expanded={open}
        title="分支：切换 / 新建"
        onClick={toggle}
      >
        <span className="git-branch-icon">⑂</span>
        <span className="git-branch-name">{props.branch ?? '—'}</span>
        {props.behind ? (
          <span className="git-branch-count">↓{props.behind}</span>
        ) : null}
        {props.ahead ? (
          <span className="git-branch-count">↑{props.ahead}</span>
        ) : null}
        <span className="git-branch-caret">▾</span>
      </button>
      {open && (
        <div className="git-branch-menu" role="menu">
          <div className="git-branch-section">本地分支</div>
          <ul className="git-branch-list">
            {props.branches.length === 0 && (
              <li className="git-branch-empty">暂无分支</li>
            )}
            {props.branches.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  role="menuitem"
                  className="git-branch-item"
                  disabled={name === props.branch || props.busy}
                  onClick={() => {
                    closeMenu()
                    props.onSwitch(name)
                  }}
                >
                  <span className="git-branch-check">
                    {name === props.branch ? '✓' : ''}
                  </span>
                  <span className="git-branch-item-name">{name}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="git-branch-section">远程分支</div>
          <ul className="git-branch-list">
            {props.remoteBranches.length === 0 && (
              <li className="git-branch-empty">暂无远程分支</li>
            )}
            {props.remoteBranches.map((ref) => (
              <li key={ref}>
                <button
                  type="button"
                  role="menuitem"
                  className="git-branch-item"
                  disabled={props.busy}
                  title={`基于 ${ref} 创建本地分支`}
                  onClick={() => prefillFromRemote(ref)}
                >
                  <span className="git-branch-check">⭳</span>
                  <span className="git-branch-item-name">{ref}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="git-branch-create">
            {startRef !== null && (
              <div className="git-branch-start-ref">
                <span>基于 {startRef}</span>
                <button
                  type="button"
                  className="git-branch-start-clear"
                  title="清除起点，改回基于当前 HEAD"
                  onClick={() => setStartRef(null)}
                >
                  ×
                </button>
              </div>
            )}
            <input
              ref={inputRef}
              className="git-branch-input"
              placeholder="新分支名称"
              value={newName}
              disabled={props.busy}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') create()
              }}
            />
            <div className="git-branch-create-actions">
              <label className="git-branch-checkout">
                <input
                  type="checkbox"
                  checked={checkout}
                  disabled={props.busy}
                  onChange={(event) => setCheckout(event.target.checked)}
                />
                创建并切换
              </label>
              <button
                type="button"
                className="ghost"
                disabled={trimmed === '' || props.busy}
                onClick={create}
              >
                创建
              </button>
            </div>
          </div>
          <GitRemotesSection
            remotes={props.remotes}
            busy={props.busy}
            onRemoteAdd={props.onRemoteAdd}
            onRemoteRemove={props.onRemoteRemove}
          />
        </div>
      )}
    </div>
  )
}
