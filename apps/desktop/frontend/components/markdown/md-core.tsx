/**
 * Markdown 渲染内核：react-markdown + remark-gfm，聊天消息与 workspace
 * 文件预览共用。语义 HTML 经组件映射挂回既有 .md-* 类名（样式见
 * styles/markdown.css），保持与原手写渲染器一致的交互契约：资源引用
 * 渲染为受控按钮、代码块/表格悬停复制、流式尾部闪烁光标。
 */
import { Children, useMemo, type ComponentProps } from 'react'
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
} from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ResourceLink } from '@reflexion-os-studio/runtime-client'
import { CopyButton } from '../CopyButton'
import {
  displayNameOf,
  parseResourceLink,
  type MarkdownCoreProps,
} from './md-core-types'

type ResourceClickHandler = (link: ResourceLink) => void

/** hast 节点最小结构（本地结构化访问，避免直接依赖 hast 类型包）。 */
interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children?: HastChild[]
}

interface HastText {
  type: 'text'
  value?: string
}

type HastChild = HastElement | HastText

/** 递归收集节点树全部文本（光标等无文本元素自然被跳过）。 */
function textOfChildren(children: readonly HastChild[] | undefined): string {
  let out = ''
  for (const child of children ?? []) {
    if (child.type === 'text') {
      if (child.value !== undefined) out += child.value
    } else {
      out += textOfChildren(child.children)
    }
  }
  return out
}

function elementChildOf(
  node: HastElement | undefined,
  tagName: string,
): HastElement | undefined {
  for (const child of node?.children ?? []) {
    if (child.type === 'element' && child.tagName === tagName) return child
  }
  return undefined
}

/** 围栏代码语言：来自代码元素的 language-* 类名，无标注返回空。 */
function codeLangOf(code: HastElement | undefined): string {
  const className = code?.properties?.className
  if (!Array.isArray(className)) return ''
  for (const item of className) {
    if (typeof item === 'string' && item.startsWith('language-')) {
      return item.slice('language-'.length)
    }
  }
  return ''
}

/** 表格 TSV 文案（复制按钮用）：行内 \t、行间 \n。 */
function tableTsvOf(node: HastElement | undefined): string {
  const rows: string[] = []
  for (const section of node?.children ?? []) {
    if (section.type !== 'element') continue
    for (const row of section.children ?? []) {
      if (row.type !== 'element' || row.tagName !== 'tr') continue
      const cells: string[] = []
      for (const cell of row.children ?? []) {
        if (cell.type !== 'element') continue
        cells.push(textOfChildren(cell.children))
      }
      if (cells.length > 0) rows.push(cells.join('\t'))
    }
  }
  return rows.join('\n')
}

function caretSpan(): HastElement {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['stream-caret'], ariaHidden: 'true' },
    children: [],
  }
}

function lastElementOf(
  nodes: HastChild[] | undefined,
  tagName: string,
): HastElement | undefined {
  const list = nodes ?? []
  for (let index = list.length - 1; index >= 0; index--) {
    const node = list[index]
    if (node.type === 'element' && node.tagName === tagName) return node
  }
  return undefined
}

/** 引用块内最后一个列表的最后一个列表项（caret 下潜用）。 */
function lastListItemOf(
  nodes: HastChild[] | undefined,
): HastElement | undefined {
  const list = lastElementOf(nodes, 'ul') ?? lastElementOf(nodes, 'ol')
  if (list === undefined) return undefined
  return lastElementOf(list.children, 'li')
}

/**
 * 把光标 span 追加到块的文本末尾；容器型标签下潜到内容节点，
 * 避免生成非法子结构（ul/table 直接挂 span 会被浏览器重排）。
 */
function appendCaret(node: HastChild | undefined): void {
  if (node === undefined || node.type !== 'element') return
  switch (node.tagName) {
    case 'ul':
    case 'ol':
      appendCaret(lastElementOf(node.children, 'li'))
      return
    case 'blockquote': {
      const inner =
        lastElementOf(node.children, 'p') ??
        lastListItemOf(node.children) ??
        lastElementOf(node.children, 'blockquote')
      if (inner !== undefined) {
        appendCaret(inner)
        return
      }
      break
    }
    case 'table': {
      const section =
        lastElementOf(node.children, 'tbody') ??
        lastElementOf(node.children, 'thead')
      const row = lastElementOf(section?.children, 'tr')
      appendCaret(
        lastElementOf(row?.children, 'td') ??
          lastElementOf(row?.children, 'th'),
      )
      return
    }
  }
  node.children = [...(node.children ?? []), caretSpan()]
}

/** rehype 微插件：caret 模式下给最后一个顶层块追加流式光标。 */
const rehypeStreamCaret = (): ((tree: unknown) => void) => (tree) => {
  const blocks = (tree as HastElement).children ?? []
  appendCaret(blocks[blocks.length - 1])
}

/** 资源协议放行（defaultUrlTransform 会把 workspace:// 洗成空串）。 */
function urlTransform(value: string): string {
  if (/^(?:workspace|asset):\/\//i.test(value)) return value
  return defaultUrlTransform(value)
}

type AnchorProps = ComponentProps<'a'> & ExtraProps
type PreProps = ComponentProps<'pre'> & ExtraProps
type TableProps = ComponentProps<'table'> & ExtraProps
type ImgProps = ComponentProps<'img'> & ExtraProps

/** 链接覆写：资源引用渲染为受控按钮，其余按外链打开。 */
function AnchorOverride(
  props: AnchorProps,
  onResourceClick?: ResourceClickHandler,
): React.JSX.Element {
  const href = props.href ?? ''
  const resource =
    onResourceClick !== undefined ? parseResourceLink(href) : null
  if (resource !== null && onResourceClick !== undefined) {
    const handler = onResourceClick
    return (
      <button
        type="button"
        className={`md-resource md-resource-${resource.kind}`}
        title={resource.uri}
        onClick={() => handler(resource)}
      >
        {Children.count(props.children) > 0
          ? props.children
          : displayNameOf(resource)}
      </button>
    )
  }
  return (
    <a className="md-link" href={href} target="_blank" rel="noreferrer">
      {Children.count(props.children) > 0 ? props.children : href}
    </a>
  )
}

/** 代码块覆写：包复制按钮并还原 .md-pre 语言角标。 */
function PreOverride(props: PreProps): React.JSX.Element {
  const node = props.node as HastElement | undefined
  const code = elementChildOf(node, 'code')
  const lang = codeLangOf(code)
  return (
    <div className="md-code-block">
      <pre className="md-pre" data-lang={lang === '' ? undefined : lang}>
        {props.children}
      </pre>
      <CopyButton
        text={textOfChildren(code?.children)}
        className="md-block-copy copy-btn"
      />
    </div>
  )
}

/** 表格覆写：套 .md-table-wrap 并挂 TSV 复制按钮。 */
function TableOverride(props: TableProps): React.JSX.Element {
  return (
    <div className="md-table-wrap">
      <table className="md-table">{props.children}</table>
      <CopyButton
        text={tableTsvOf(props.node as HastElement | undefined)}
        className="md-block-copy copy-btn"
      />
    </div>
  )
}

/** 图片占位：相对 src 在 WebView 内无法解析，真渲染属图片预览迭代。 */
function ImageOverride(props: ImgProps): React.JSX.Element {
  const alt = props.alt ?? ''
  return (
    <span className="md-img" title={props.src ?? ''}>
      图片{alt === '' ? '' : `：${alt}`}
    </span>
  )
}

const BASE_COMPONENTS: Components = {
  p: (props) => <p className="md-p">{props.children}</p>,
  h1: (props) => <h1 className="md-h md-h1">{props.children}</h1>,
  h2: (props) => <h2 className="md-h md-h2">{props.children}</h2>,
  h3: (props) => <h3 className="md-h md-h3">{props.children}</h3>,
  h4: (props) => <h4 className="md-h md-h4">{props.children}</h4>,
  // 5/6 级标题按最小档视觉处理（原渲染器仅支持 1-4 级）。
  h5: (props) => <h5 className="md-h md-h4">{props.children}</h5>,
  h6: (props) => <h6 className="md-h md-h4">{props.children}</h6>,
  ul: (props) => <ul className="md-list">{props.children}</ul>,
  ol: (props) => <ol className="md-list">{props.children}</ol>,
  blockquote: (props) => (
    <blockquote className="md-quote">{props.children}</blockquote>
  ),
  hr: () => <hr className="md-hr" />,
  pre: PreOverride,
  table: TableOverride,
  img: ImageOverride,
  // 行内代码挂 md-code 芯片；块内代码的芯片外观由 .md-pre code 规则重置。
  code: (props) => <code className="md-code">{props.children}</code>,
}

export function MarkdownCore(props: MarkdownCoreProps): React.JSX.Element {
  const caret = props.caret === true
  // onResourceClick 是自定义回调，经闭包注入 anchor 覆写（DOM props 不承载）。
  const components = useMemo<Components>(
    () => ({
      ...BASE_COMPONENTS,
      a: (anchorProps: AnchorProps) =>
        AnchorOverride(anchorProps, props.onResourceClick),
    }),
    [props.onResourceClick],
  )
  const inner =
    props.text.trim() === '' ? (
      caret ? (
        <p className="md-p">
          <span className="stream-caret" aria-hidden="true" />
        </p>
      ) : null
    ) : (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={caret ? [rehypeStreamCaret] : []}
        urlTransform={urlTransform}
        components={components}
      >
        {props.text}
      </ReactMarkdown>
    )
  if (props.bare === true) return <>{inner}</>
  return <div className="md">{inner}</div>
}
