import { useState } from 'react'

interface ReasoningBlockProps {
  text: string
  /** 思考仍在流式输出中：预览行显示呼吸/脉冲反馈，让用户知道还在实时更新。 */
  active?: boolean
}

export function ReasoningBlock(props: ReasoningBlockProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`reasoning-block${open ? ' open' : ''}`}>
      <button
        type="button"
        className={`reasoning-toggle${props.active ? ' active' : ''}`}
        aria-label={open ? '收起思考过程' : '展开思考过程'}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-label">思考</span>
        <span className="reasoning-preview" dir="rtl">
          <bdi>{props.text.replace(/\s+/g, ' ').trim()}</bdi>
        </span>
      </button>
      {open && <div className="reasoning-full">{props.text}</div>}
    </div>
  )
}
