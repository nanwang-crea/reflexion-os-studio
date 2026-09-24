import { useState } from 'react'

interface ReasoningBlockProps {
  text: string
  /** 思考仍在流式输出中：预览行显示呼吸/脉冲反馈，让用户知道还在实时更新。 */
  active?: boolean
}

const SUMMARY_MAX_CHARS = 180

function summarize(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= SUMMARY_MAX_CHARS) return compact
  // 超长时展示最新内容（尾部）：思考过程中预览持续跟进实时输出，
  // 而不是固定取开头一段（开头固定不变会让长思考看起来像卡住）。
  return `…${compact.slice(-(SUMMARY_MAX_CHARS - 1))}`
}

export function ReasoningBlock(props: ReasoningBlockProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`reasoning-block${open ? ' open' : ''}`}>
      <button
        type="button"
        className={`reasoning-toggle${props.active ? ' active' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="reasoning-label">思考</span>
        <span className="reasoning-preview">{summarize(props.text)}</span>
      </button>
      {open && <div className="reasoning-full">{props.text}</div>}
    </div>
  )
}
