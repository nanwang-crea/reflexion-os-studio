import { useEffect, useRef, useState } from 'react'
import { ChevronIcon } from '../ui/icons'

interface ThinkingPanelProps {
  /** 思考文本；空串时只显示标题态（连接尚未产出增量的阶段）。 */
  text: string
  /** true 时标题为“思考中…”并自动展开、正文跟随滚动；结束后自动收起。 */
  streaming: boolean
}

/**
 * 推理模型的思考面板：思考中自动展开并流式跟随，回答开始后自动收起为
 * “已深度思考”标签；用户可随时手动开合（手动状态保留，直到下次流式状态切换）。
 */
export function ThinkingPanel(props: ThinkingPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(props.streaming)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 跟随流式状态：思考中展开、结束后收起；手动开合在下一次状态切换前有效。
  useEffect(() => {
    setOpen(props.streaming)
  }, [props.streaming])

  // 思考进行中正文自动滚到底部，让用户持续看到新思考内容。
  useEffect(() => {
    if (!open || !props.streaming) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [props.text, open, props.streaming])

  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span
          className={
            props.streaming ? 'thinking-label shimmer' : 'thinking-label'
          }
        >
          {props.streaming ? '思考中…' : '已深度思考'}
        </span>
        <span className={`thinking-chevron${open ? ' open' : ''}`}>
          <ChevronIcon />
        </span>
      </button>
      {open && props.text !== '' && (
        <div className="thinking-body" ref={bodyRef}>
          {props.text}
        </div>
      )}
    </div>
  )
}
