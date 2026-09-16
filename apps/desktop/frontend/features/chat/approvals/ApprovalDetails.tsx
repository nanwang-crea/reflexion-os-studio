import { useEffect, useRef, useState } from 'react'
import type { ApprovalDisplay } from './approval-presenter'

/**
 * 审批主体区：操作主体（路径/命令）+ 关键范围短标签 + 规则说明 +
 * 默认收起的"查看详情"。长命令限高滚动 + 复制；不允许横向撑破卡片。
 */
export function ApprovalDetails({
  display,
  descriptionId,
}: {
  display: ApprovalDisplay
  descriptionId: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // Esc 只收起详情（拒绝永远绑定显式按钮，不挂在容易误触的全局键上）。
  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key === 'Escape' &&
        bodyRef.current?.contains(event.target as Node)
      ) {
        event.stopPropagation()
        setExpanded(false)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [expanded])
  return (
    <div className="approval-body" ref={bodyRef}>
      {display.subject !== null && (
        <div
          className={`approval-subject kind-${display.subject.kind}`}
          id={descriptionId}
        >
          {display.subject.kind === 'command' ? (
            <>
              <code className="approval-command">{display.subject.value}</code>
              <button
                type="button"
                className="approval-copy"
                aria-label="复制命令"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    display.subject?.value ?? '',
                  )
                }
              >
                复制
              </button>
            </>
          ) : (
            <code className="approval-path">{display.subject.value}</code>
          )}
        </div>
      )}
      {display.chips.length > 0 && (
        <div className="approval-chips" aria-label="执行范围">
          {display.chips.map((chip) => (
            <span key={chip} className={`approval-chip chip-${chipTone(chip)}`}>
              {chip}
            </span>
          ))}
        </div>
      )}
      {display.ruleNote !== null && (
        <p className="approval-rule-note">{display.ruleNote}</p>
      )}
      <button
        type="button"
        className="approval-details-toggle ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? '收起详情' : '查看详情'}
      </button>
      {expanded && (
        <dl className="approval-detail-list">
          {display.details.map((item) => (
            <div key={item.label} className="approval-detail-item">
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

function chipTone(chip: string): 'neutral' | 'elevated' | 'warning' {
  if (
    chip.startsWith('提权') ||
    chip.startsWith('Danger') ||
    chip === '将联网'
  ) {
    return 'elevated'
  }
  if (chip === '将访问工作区外') return 'elevated'
  if (chip === '沙箱只读') return 'warning'
  return 'neutral'
}
