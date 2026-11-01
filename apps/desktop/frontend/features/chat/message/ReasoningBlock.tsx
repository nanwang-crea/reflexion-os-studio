import { useState } from 'react'

/** 折叠行预览保留的最新思考字符数；超出部分截去开头。 */
const PREVIEW_MAX_CHARS = 160

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
        <span className="reasoning-preview">{previewOf(props.text)}</span>
      </button>
      {open && <div className="reasoning-full">{props.text}</div>}
    </div>
  )
}

/**
 * 预览文本：压平换行，过长时只留结尾（最新思考）并加前导省略号。
 * 靠 CSS 的 dir=rtl 起头省略会把文字推到行末、与标签之间留大段空白，
 * 因此改为在 JS 里截断，预览按自身内容宽度紧跟在标签后。
 */
function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_MAX_CHARS
    ? `…${flat.slice(-PREVIEW_MAX_CHARS)}`
    : flat
}
