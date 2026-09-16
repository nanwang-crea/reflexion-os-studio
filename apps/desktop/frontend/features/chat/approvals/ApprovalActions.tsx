import { useEffect, useRef, useState } from 'react'
import type { ApprovalChoice } from '@reflexion-os-studio/runtime-client'
import type { ApprovalDisplay } from './approval-presenter'

/**
 * 审批动作区：只渲染 Runtime 下发的 choices（label/description 原样展示），
 * 提交只回传 choiceId。存在会话级 choice 时收进"始终允许…"菜单——它是
 * 会话规则选择器（本会话内免问），不是跨会话永久授权。
 */
export function ApprovalActions({
  display,
  busyLabel,
  onChoose,
}: {
  display: ApprovalDisplay
  /** 非空表示已提交在途：按钮禁用防重复点击。 */
  busyLabel: string | null
  onChoose: (choiceId: string) => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const sessionChoices = display.choices.filter(
    (choice) => choice.presentation === 'session-menu',
  )
  const deny = display.choices.find((choice) => choice.decision === 'denied')
  const primaries = display.choices.filter(
    (choice) => choice.presentation === 'primary',
  )
  const busy = busyLabel !== null

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menuOpen])

  return (
    <div className="approval-actions">
      {deny && (
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => onChoose(deny.id)}
        >
          {deny.label}
        </button>
      )}
      {sessionChoices.length > 0 && (
        <div className="approval-session-menu" ref={menuRef}>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            始终允许…
          </button>
          {menuOpen && (
            <div className="approval-menu" role="menu">
              {sessionChoices.map((choice) => (
                <MenuChoice
                  key={choice.id}
                  choice={choice}
                  disabled={busy}
                  onChoose={(id) => {
                    setMenuOpen(false)
                    onChoose(id)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {primaries.map((choice, index) => (
        <button
          key={choice.id}
          type="button"
          className={
            primaries.length > 1 && index < primaries.length - 1
              ? 'ghost'
              : 'primary'
          }
          title={choice.description}
          disabled={busy}
          onClick={() => onChoose(choice.id)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  )
}

function MenuChoice({
  choice,
  disabled,
  onChoose,
}: {
  choice: ApprovalChoice
  disabled: boolean
  onChoose: (id: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className="approval-menu-item"
      disabled={disabled}
      onClick={() => onChoose(choice.id)}
    >
      <span className="menu-label">{choice.label}</span>
      {choice.description && (
        <span className="menu-description">{choice.description}</span>
      )}
    </button>
  )
}
