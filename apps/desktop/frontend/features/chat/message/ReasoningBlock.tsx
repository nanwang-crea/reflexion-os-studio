import { useState } from 'react'

/** 折叠行预览保留的最新思考字符数；超出部分截去开头。 */
const PREVIEW_MAX_CHARS = 160

interface ReasoningBlockProps {
  text: string
  /** 思考仍在流式输出中：预览行显示呼吸/脉冲反馈，让用户知道还在实时更新。 */
  active?: boolean
  /** 紧凑视图：一行“深度求索中，用时 X”+ 最新预览，点击展开全文。 */
  compact?: boolean
  /** 紧凑视图下显示已用时长（从 Run 开始计）；缺省不显示。 */
  elapsedMs?: number | null
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes > 0)
    return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
  return `${seconds} 秒`
}

export function ReasoningBlock(props: ReasoningBlockProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (props.compact) {
    const elapsed =
      props.elapsedMs !== null && props.elapsedMs !== undefined
        ? formatElapsed(props.elapsedMs)
        : null
    return (
      <div className="reasoning-block compact">
        <button
          type="button"
          className={`reasoning-toggle${props.active ? ' active' : ''}`}
          aria-label={open ? '收起思考过程' : '展开思考过程'}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="reasoning-label">
            {props.active ? '深度求索中' : '深度思考'}
            {elapsed !== null ? `，用时 ${elapsed}` : ''}
          </span>
          <span className="reasoning-preview">{previewOf(props.text)}</span>
        </button>
        {open && <div className="reasoning-full">{props.text}</div>}
      </div>
    )
  }
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
