/**
 * Markdown 内核的 hast 结构化访问与 rehype 微插件（无 JSX、无 React 依赖）。
 * 从 md-core 拆出：光标下潜、块浮现标记与资源协议放行都只操作语法树。
 */
import { defaultUrlTransform } from 'react-markdown'

/** hast 节点最小结构（本地结构化访问，避免直接依赖 hast 类型包）。 */
export interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children?: HastChild[]
}

interface HastText {
  type: 'text'
  value?: string
}

export type HastChild = HastElement | HastText

/** 递归收集节点树全部文本（光标等无文本元素自然被跳过）。 */
export function textOfChildren(
  children: readonly HastChild[] | undefined,
): string {
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

export function elementChildOf(
  node: HastElement | undefined,
  tagName: string,
): HastElement | undefined {
  for (const child of node?.children ?? []) {
    if (child.type === 'element' && child.tagName === tagName) return child
  }
  return undefined
}

/** 围栏代码语言：来自代码元素的 language-* 类名，无标注返回空。 */
export function codeLangOf(code: HastElement | undefined): string {
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
export function tableTsvOf(node: HastElement | undefined): string {
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
function markStreamingTail(node: HastChild | undefined): void {
  if (node?.type === 'element') {
    node.properties = {
      ...(node.properties ?? {}),
      'data-streaming-tail': 'true',
    }
  }
}

function markStreamReveal(node: HastChild | undefined): void {
  if (node?.type === 'element') {
    node.properties = {
      ...(node.properties ?? {}),
      'data-stream-reveal': 'true',
    }
  }
}

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
export const rehypeStreamCaret = (): ((tree: unknown) => void) => (tree) => {
  const blocks = (tree as HastElement).children ?? []
  const tail = blocks[blocks.length - 1]
  markStreamingTail(tail)
  appendCaret(tail)
}

/**
 * 只给本次新增的、已经完成的顶层块挂一次性浮现标记。
 * 正在增长的尾块不标记，避免每个 delta 都重新播放动画。
 */
export const rehypeStreamReveal = (): ((tree: unknown) => void) => (tree) => {
  const blocks = (tree as HastElement).children ?? []
  const elementBlocks = blocks.filter((child) => child.type === 'element')
  for (let index = 0; index < elementBlocks.length - 1; index += 1) {
    markStreamReveal(elementBlocks[index])
  }
}

/**
 * 缓存块专用：一块一个 ReactMarkdown，插件只看得到该块自身的顶层节点，
 * 因此直接标记全部元素块——新块首次挂载时播放一次浮现动画。
 */
export const rehypeStreamRevealBlock =
  (): ((tree: unknown) => void) => (tree) => {
    for (const child of (tree as HastElement).children ?? []) {
      if (child.type === 'element') markStreamReveal(child)
    }
  }

/** 资源协议放行（defaultUrlTransform 会把 workspace:// 洗成空串）。 */
export function urlTransform(value: string): string {
  if (/^(?:workspace|asset):\/\//i.test(value)) return value
  return defaultUrlTransform(value)
}
