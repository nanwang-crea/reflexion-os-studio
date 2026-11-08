import { useState } from 'react'
import { ThinkIcon } from '../../../ui/icons'

/** 折叠行预览保留的最新思考字符数；超出部分截去开头。 */
const PREVIEW_MAX_CHARS = 160

interface ReasoningBlockProps {
  text: string
  /** 思考仍在流式输出中：预览行显示呼吸/脉冲反馈，让用户知道还在实时更新。 */
  active?: boolean
  /** 标准视图：带思考图标，折叠时显示“最近一段首行”预览（参考 DSH）。 */
  compact?: boolean
}

/**
 * 标准视图的折叠摘要：运行中取“最近一个已完成段落”的首行（随流式推进而
 * 前进），结束后取全文首行。与 DSH ReasoningRow 口径一致，避免一行里塞进
 * 整段结尾的噪声。
 */
export function reasoningSummary(text: string, running: boolean): string {
  if (!running) return firstLine(text)
  let summary = ''
  let paragraphStart = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  for (;;) {
    const nextParagraph = separator.exec(text)
    const paragraphEnd =
      nextParagraph === null
        ? text.length
        : nextParagraph.index + nextParagraph[0].indexOf('\n')
    const newline = text.indexOf('\n', paragraphStart)
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim()
      if (candidate !== '') summary = candidate
    }
    if (nextParagraph === null) return summary
    paragraphStart = nextParagraph.index + nextParagraph[0].length
  }
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return (newline === -1 ? text : text.slice(0, newline)).trim()
}

export function ReasoningBlock(props: ReasoningBlockProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // 详细视图保留“压平后取最新尾部”的预览语义；标准视图按 DSH 只取段落首行。
  const compactSummary = reasoningSummary(
    props.text,
    props.active === true,
  ).replaceAll('**', '')
  const detailPreview = previewOf(props.text)
  return (
    <div
      className={`reasoning-block${open ? ' open' : ''}${props.compact ? ' compact' : ''}`}
      data-expanded={open || undefined}
    >
      <button
        type="button"
        className={`reasoning-toggle${props.active ? ' active' : ''}`}
        aria-label={open ? '收起思考过程' : '展开思考过程'}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {props.compact ? (
          <>
            <span className="reasoning-label">
              <ThinkIcon size={14} />
              思考
            </span>
            {!open && compactSummary !== '' && (
              <span
                className="reasoning-preview"
                data-streaming={props.active || undefined}
              >
                {truncatePreview(compactSummary)}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="reasoning-label">思考</span>
            <span className="reasoning-preview">{detailPreview}</span>
          </>
        )}
      </button>
      {open && <div className="reasoning-full">{props.text}</div>}
    </div>
  )
}

function truncatePreview(text: string): string {
  return text.length > PREVIEW_MAX_CHARS
    ? `…${text.slice(-PREVIEW_MAX_CHARS)}`
    : text
}

/**
 * 详细视图预览：压平换行，过长时只留结尾（最新思考）并加前导省略号。
 * 靠 CSS 的 dir=rtl 起头省略会把文字推到行末、与标签之间留大段空白，
 * 因此改为在 JS 里截断，预览按自身内容宽度紧跟在标签后。
 */
function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_MAX_CHARS
    ? `…${flat.slice(-PREVIEW_MAX_CHARS)}`
    : flat
}
