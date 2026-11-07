/**
 * Markdown 渲染内核：react-markdown + remark-gfm，聊天消息与 workspace
 * 文件预览共用。语义 HTML 经组件映射挂回既有 .md-* 类名（样式见
 * styles/markdown.css），保持与原手写渲染器一致的交互契约：资源引用
 * 渲染为受控按钮、代码块/表格悬停复制、流式尾部闪烁光标。
 *
 * 流式模式按顶层块分块渲染（见 md-stream）：已完成块命中缓存，每次 flush
 * 只重新 parse 尾块，避免整段文本反复解析导致的输入卡顿。
 */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MarkdownCoreProps } from './md-core-types'
import { urlTransform } from './md-hast'
import { MARKDOWN_COMPONENTS, ResourceClickProvider } from './md-overrides'
import { StreamedMarkdown } from './md-stream'

export function MarkdownCore(props: MarkdownCoreProps): React.JSX.Element {
  const caret = props.caret === true
  const inner =
    props.text.trim() === '' ? (
      caret ? (
        <p className="md-p">
          <span className="stream-caret" aria-hidden="true" />
        </p>
      ) : null
    ) : caret ? (
      <StreamedMarkdown text={props.text} components={MARKDOWN_COMPONENTS} />
    ) : (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={MARKDOWN_COMPONENTS}
      >
        {props.text}
      </ReactMarkdown>
    )
  const body = (
    <ResourceClickProvider value={props.onResourceClick}>
      {inner}
    </ResourceClickProvider>
  )
  if (props.bare === true) return <>{body}</>
  return <div className={`md${caret ? ' md-streaming' : ''}`}>{body}</div>
}
