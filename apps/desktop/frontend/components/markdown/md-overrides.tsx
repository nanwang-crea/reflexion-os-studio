/**
 * Markdown 组件映射（模块级常量，性能 P0）：语义 HTML 挂回既有 .md-* 类名，
 * 保持与原手写渲染器一致的交互契约（资源引用按钮、代码块/表格悬停复制、
 * 图片占位）。资源点击回调用 context 注入，回调变化不再重建整份映射。
 */
import { Children, createContext, useContext, type ComponentProps } from 'react'
import type { Components, ExtraProps } from 'react-markdown'
import type { ResourceLink } from '@reflexion-os-studio/runtime-client'
import { CopyButton } from '../CopyButton'
import { displayNameOf, parseResourceLink } from './md-core-types'
import {
  codeLangOf,
  elementChildOf,
  tableTsvOf,
  textOfChildren,
  type HastElement,
} from './md-hast'

export type ResourceClickHandler = (link: ResourceLink) => void

/** 自适应组件的资源回调通道（DOM props 不承载自定义回调）。 */
const ResourceClickContext = createContext<ResourceClickHandler | undefined>(
  undefined,
)

export const ResourceClickProvider = ResourceClickContext.Provider

type AnchorProps = ComponentProps<'a'> & ExtraProps
type PreProps = ComponentProps<'pre'> & ExtraProps
type TableProps = ComponentProps<'table'> & ExtraProps
type ImgProps = ComponentProps<'img'> & ExtraProps

/** 链接覆写：资源引用渲染为受控按钮，其余按外链打开。 */
function AnchorOverride(props: AnchorProps): React.JSX.Element {
  const onResourceClick = useContext(ResourceClickContext)
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

export const MARKDOWN_COMPONENTS: Components = {
  a: AnchorOverride,
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
