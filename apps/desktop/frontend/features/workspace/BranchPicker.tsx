import { useEffect, useRef, useState } from 'react'

interface BranchPickerProps {
  branch: string | null
  ahead: number | null
  behind: number | null
  branches: string[]
  busy: boolean
  /** 切换分支；守卫与错误处理由父层承担。 */
  onSwitch: (name: string) => void
  /** 新建分支；checkout=true 时同时切换过去。 */
  onCreate: (name: string, checkout: boolean) => void
  /** 展开菜单时请求父层刷新分支列表。 */
  onRefresh: () => void
}

/** 分支芯片（当前分支 + ahead/behind 计数）与下拉菜单（切换 / 新建分支）。 */
export function BranchPicker(props: BranchPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [checkout, setCheckout] = useState(true)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next) props.onRefresh()
  }

  const trimmed = newName.trim()

  const create = (): void => {
    if (trimmed === '') return
    setOpen(false)
    setNewName('')
    props.onCreate(trimmed, checkout)
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
                    setOpen(false)
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
          <div className="git-branch-create">
            <input
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
        </div>
      )}
    </div>
  )
}
