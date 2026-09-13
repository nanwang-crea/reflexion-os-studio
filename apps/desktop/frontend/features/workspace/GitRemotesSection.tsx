import { useEffect, useRef, useState } from 'react'
import type { GitRemote } from '../../api/workspace'

interface GitRemotesSectionProps {
  remotes: GitRemote[]
  busy: boolean
  /** 添加远端；返回是否成功（成功时表单收起并清空）。 */
  onRemoteAdd: (name: string, url: string) => Promise<boolean>
  /** 移除远端；返回是否成功。 */
  onRemoteRemove: (name: string) => Promise<boolean>
}

/** 确认按钮超时回退窗口。 */
const CONFIRM_REVERT_MS = 3000

/** 远端分区：remote 列表（name + 脱敏 URL + 两步确认移除）与添加表单。 */
export function GitRemotesSection(
  props: GitRemotesSectionProps,
): React.JSX.Element {
  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('origin')
  const [url, setUrl] = useState('')
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const revertTimer = useRef<number | null>(null)

  const clearRevert = (): void => {
    if (revertTimer.current !== null) {
      window.clearTimeout(revertTimer.current)
      revertTimer.current = null
    }
  }
  useEffect(() => clearRevert, [])

  const trimmedName = name.trim()
  const trimmedUrl = url.trim()

  const armConfirm = (remote: string): void => {
    clearRevert()
    setConfirmName(remote)
    revertTimer.current = window.setTimeout(() => {
      revertTimer.current = null
      setConfirmName(null)
    }, CONFIRM_REVERT_MS)
  }

  const remove = (remote: string): void => {
    clearRevert()
    setConfirmName(null)
    void props.onRemoteRemove(remote)
  }

  const save = (): void => {
    if (trimmedName === '' || trimmedUrl === '') return
    void props.onRemoteAdd(trimmedName, trimmedUrl).then((ok) => {
      if (!ok) return
      setName('origin')
      setUrl('')
      setAddOpen(false)
    })
  }

  return (
    <div className="git-remote-section">
      <div className="git-branch-section">远端</div>
      {props.remotes.length === 0 ? (
        <div className="git-branch-empty">暂无远端</div>
      ) : (
        <ul className="git-branch-list">
          {props.remotes.map((remote) => (
            <li key={remote.name} className="git-remote-row">
              <span className="git-remote-name">{remote.name}</span>
              <span className="git-remote-url" title={remote.url}>
                {remote.url}
              </span>
              <button
                type="button"
                className={
                  confirmName === remote.name
                    ? 'git-remote-remove git-remote-remove-confirm'
                    : 'git-remote-remove'
                }
                disabled={props.busy}
                title={
                  confirmName === remote.name
                    ? '再次点击确认移除（仅删远端配置与引用）'
                    : '移除远端'
                }
                onClick={() => {
                  if (confirmName === remote.name) remove(remote.name)
                  else armConfirm(remote.name)
                }}
              >
                {confirmName === remote.name ? '确认移除？' : '移除'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="git-branch-create-actions">
        <button
          type="button"
          className="ghost"
          disabled={props.busy}
          aria-expanded={addOpen}
          onClick={() => setAddOpen((prev) => !prev)}
        >
          {addOpen ? '取消添加' : '添加远端'}
        </button>
      </div>
      {addOpen && (
        <div className="git-remote-add-form">
          <input
            className="git-branch-input"
            placeholder="远端名称"
            value={name}
            disabled={props.busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save()
            }}
          />
          <input
            className="git-branch-input"
            placeholder="URL（https://… 或 git@host:path）"
            value={url}
            disabled={props.busy}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save()
            }}
          />
          <div className="git-branch-create-actions">
            <span className="git-branch-checkout">仅写本地仓库配置</span>
            <button
              type="button"
              className="ghost"
              disabled={props.busy || trimmedName === '' || trimmedUrl === ''}
              onClick={save}
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
