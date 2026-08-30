import type { ReactNode } from 'react'

/**
 * 轻量 Markdown 渲染：覆盖对话常见结构（标题 / 列表 / 引用 / 围栏代码 /
 * 行内加粗、斜体、删除线、代码、链接），零依赖，且对未完成的流式输入
 * （如未闭合的代码围栏）保持稳定渲染。表格等复杂结构暂不支持。
 */

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string; open: boolean }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }

const FENCE_RE = /^```(.*)$/
const HEADING_RE = /^(#{1,4})\s+(.*)$/
const UL_ITEM_RE = /^[-*]\s+(.*)$/
const OL_ITEM_RE = /^\d{1,3}[.、)]\s+(.*)$/
const QUOTE_RE = /^>\s?(.*)$/
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})$/
const LINK_RE = /^\[([^\]]*)\]\(([^)\s]*)\)$/
const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*\n]+?\*)|(~~[^~]+?~~)|(\[[^\]]*\]\([^)\s]*\))/g

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0
    if (index > last) nodes.push(text.slice(last, index))
    const token = match[0]
    const id = `${keyBase}-${key++}`
    if (token.startsWith('`')) {
      nodes.push(
        <code key={id} className="md-code">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={id}>{renderInline(token.slice(2, -2), id)}</strong>,
      )
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={id}>{renderInline(token.slice(2, -2), id)}</del>)
    } else if (token.startsWith('*')) {
      nodes.push(<em key={id}>{renderInline(token.slice(1, -1), id)}</em>)
    } else {
      const link = LINK_RE.exec(token)
      if (link) {
        nodes.push(
          <a
            key={id}
            className="md-link"
            href={link[2]}
            target="_blank"
            rel="noreferrer"
          >
            {link[1] === '' ? link[2] : link[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    }
    last = index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function parseBlocks(source: string): Block[] {
  const lines = source.split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let quote: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: { lang: string; lines: string[] } | null = null

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'p', text: paragraph.join('\n') })
      paragraph = []
    }
  }
  const flushQuote = (): void => {
    if (quote.length > 0) {
      blocks.push({ kind: 'quote', text: quote.join('\n') })
      quote = []
    }
  }
  const flushList = (): void => {
    if (list) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items })
      list = null
    }
  }
  const flushAll = (): void => {
    flushParagraph()
    flushQuote()
    flushList()
  }

  for (const line of lines) {
    if (code) {
      if (line.trimEnd() === '```') {
        blocks.push({
          kind: 'code',
          lang: code.lang,
          text: code.lines.join('\n'),
          open: false,
        })
        code = null
      } else {
        code.lines.push(line)
      }
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence) {
      flushAll()
      code = { lang: fence[1].trim(), lines: [] }
      continue
    }
    if (HR_RE.test(line.trim())) {
      flushAll()
      blocks.push({ kind: 'hr' })
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushAll()
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        text: heading[2],
      })
      continue
    }
    const ul = UL_ITEM_RE.exec(line)
    const ol = ul === null ? OL_ITEM_RE.exec(line) : null
    if (ul || ol) {
      flushParagraph()
      flushQuote()
      const ordered = ol !== null
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push((ul ?? ol)![1])
      continue
    }
    const quoted = QUOTE_RE.exec(line)
    if (quoted) {
      flushParagraph()
      flushList()
      quote.push(quoted[1])
      continue
    }
    if (line.trim() === '') {
      flushAll()
      continue
    }
    paragraph.push(line)
  }

  flushAll()
  if (code) {
    // 流式输入的未闭合围栏：把剩余内容按代码渲染，避免整段丢字。
    blocks.push({
      kind: 'code',
      lang: code.lang,
      text: code.lines.join('\n'),
      open: true,
    })
  }
  return blocks
}

function renderBlock(block: Block, key: string, withCaret: boolean): ReactNode {
  const caret = withCaret ? (
    <span className="stream-caret" aria-hidden="true" />
  ) : null
  switch (block.kind) {
    case 'p':
      return (
        <p key={key} className="md-p">
          {renderInline(block.text, key)}
          {caret}
        </p>
      )
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4'
      return (
        <Tag key={key} className={`md-h md-h${block.level}`}>
          {renderInline(block.text, key)}
          {caret}
        </Tag>
      )
    }
    case 'code':
      return (
        <pre key={key} className="md-pre" data-lang={block.lang || undefined}>
          <code>{block.text}</code>
          {caret}
        </pre>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return (
        <Tag key={key} className="md-list">
          {block.items.map((item, index) => (
            <li key={`${key}-${index}`}>
              {renderInline(item, `${key}-${index}`)}
              {index === block.items.length - 1 && caret}
            </li>
          ))}
        </Tag>
      )
    }
    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {renderInline(block.text, key)}
          {caret}
        </blockquote>
      )
    case 'hr':
      return <hr key={key} className="md-hr" />
  }
}

interface MessageMarkdownProps {
  text: string
  /** 流式进行中：在最后一个块尾追加闪烁光标。 */
  caret?: boolean
}

export function MessageMarkdown(
  props: MessageMarkdownProps,
): React.JSX.Element {
  const blocks = parseBlocks(props.text)
  const caret = props.caret === true
  const lastIndex = blocks.length - 1
  return (
    <div className="md">
      {blocks.map((block, index) =>
        renderBlock(block, `b${index}`, caret && index === lastIndex),
      )}
      {blocks.length === 0 && caret && (
        <p className="md-p">
          <span className="stream-caret" aria-hidden="true" />
        </p>
      )}
    </div>
  )
}
