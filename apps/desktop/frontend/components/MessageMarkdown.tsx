import type { ReactNode } from 'react'
import type { ResourceLink } from '@reflexion-os-studio/runtime-client'

/**
 * 轻量 Markdown 渲染：覆盖对话常见结构（标题 / 列表 / 引用 / 围栏代码 /
 * GFM 表格 / 行内加粗、斜体、删除线、代码、链接），零依赖，且对未完成的
 * 流式输入（如未闭合的代码围栏）保持稳定渲染。
 */

type Align = 'left' | 'center' | 'right'

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string; open: boolean }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; rows: string[][]; aligns: Align[] }
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
const ALIGN_CELL_RE = /^:?-+:?$/

function renderInline(
  text: string,
  keyBase: string,
  onResourceClick?: (link: ResourceLink) => void,
): ReactNode[] {
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
        <strong key={id}>
          {renderInline(token.slice(2, -2), id, onResourceClick)}
        </strong>,
      )
    } else if (token.startsWith('~~')) {
      nodes.push(
        <del key={id}>
          {renderInline(token.slice(2, -2), id, onResourceClick)}
        </del>,
      )
    } else if (token.startsWith('*')) {
      nodes.push(
        <em key={id}>
          {renderInline(token.slice(1, -1), id, onResourceClick)}
        </em>,
      )
    } else {
      const link = LINK_RE.exec(token)
      if (link) {
        const resource =
          onResourceClick !== undefined ? parseResourceLink(link[2]) : null
        if (resource !== null && onResourceClick !== undefined) {
          const handler = onResourceClick
          // 资源引用渲染为受控按钮：点击经宿主按类型分发
          // （查看器定位 / Asset 预览 / 系统浏览器），不直接导航。
          nodes.push(
            <button
              key={id}
              type="button"
              className={`md-resource md-resource-${resource.kind}`}
              title={resource.uri}
              onClick={() => handler(resource)}
            >
              {link[1] === '' ? displayNameOf(resource) : link[1]}
            </button>,
          )
        } else {
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
        }
      } else {
        nodes.push(token)
      }
    }
    last = index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** 从消息正文提取全部资源链接（供 Artifact 聚合卡与内联渲染共用）。 */
export function extractResourceLinks(text: string): ResourceLink[] {
  const links: ResourceLink[] = []
  for (const match of text.matchAll(LINK_RE_GLOBAL)) {
    const parsed = parseResourceLink(match[2])
    if (parsed !== null) links.push(parsed)
  }
  return links
}

const LINK_RE_GLOBAL = /\[([^\]]*)\]\(([^)\s]*)\)/g

/** workspace:// 与 asset:// 引用显示名：无标题文本时用最短有意义的片段。 */
function displayNameOf(link: ResourceLink): string {
  if (link.kind === 'workspaceFile') return link.path
  if (link.kind === 'asset') return link.assetId.slice(0, 8)
  return link.uri
}

/** 解析消息内资源引用协议；非资源协议（http 等）返回 null 保持普通链接。 */
function parseResourceLink(href: string): ResourceLink | null {
  if (href.startsWith('workspace://')) {
    const rest = href.slice('workspace://'.length)
    const fragmentMatch = rest.match(/^(.*?)(?:#L(\d+))?$/)
    if (fragmentMatch === null) return null
    const raw = fragmentMatch[1]
    const line = fragmentMatch[2]
    const slash = raw.indexOf('/')
    if (slash <= 0) return null
    const projectId = raw.slice(0, slash)
    const path = raw.slice(slash + 1)
    if (projectId === '' || path === '') return null
    return {
      kind: 'workspaceFile',
      uri: href,
      projectId,
      path,
      line: line === undefined ? undefined : Number.parseInt(line, 10),
    }
  }
  if (href.startsWith('asset://')) {
    const assetId = href.slice('asset://'.length)
    if (assetId === '') return null
    return { kind: 'asset', uri: href, assetId }
  }
  if (href.startsWith('https://')) {
    return { kind: 'externalUrl', uri: href }
  }
  return null
}

/** 拆一行表格行：容忍首尾竖线缺失，`\|` 转义为字面竖线。 */
function splitTableRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < row.length; index++) {
    const char = row[index]
    if (char === '\\' && row[index + 1] === '|') {
      current += '|'
      index++
    } else if (char === '|') {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false
  const cells = splitTableRow(trimmed)
  return cells.length >= 2 && cells.every((cell) => ALIGN_CELL_RE.test(cell))
}

function alignOfSeparatorCell(cell: string): Align {
  const trimmed = cell.trim()
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center'
  if (trimmed.endsWith(':')) return 'right'
  return 'left'
}

/**
 * 行 index 处是否是表头（下一行是分隔行）。返回行数组（含表头）与对齐，
 * 未构成表格（如流式中分隔行还没到）返回 null，按普通段落渲染。
 */
function tryParseTable(
  lines: string[],
  index: number,
): { rows: string[][]; aligns: Align[] } | null {
  const header = lines[index]
  if (!header.includes('|')) return null
  const separator = lines[index + 1]
  if (separator === undefined || !isTableSeparator(separator)) return null
  const headerCells = splitTableRow(header)
  const separatorCells = splitTableRow(separator)
  const aligns = headerCells.map((_, cellIndex) =>
    alignOfSeparatorCell(separatorCells[cellIndex] ?? ''),
  )
  const rows = [headerCells]
  let cursor = index + 2
  while (cursor < lines.length && lines[cursor].includes('|')) {
    rows.push(splitTableRow(lines[cursor]))
    cursor++
  }
  return { rows, aligns }
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

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
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
    const table = tryParseTable(lines, index)
    if (table) {
      flushAll()
      blocks.push({ kind: 'table', rows: table.rows, aligns: table.aligns })
      // 跳过已消费的表体行（-1 抵消循环自增）。
      index += table.rows.length + 1
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

function renderBlock(
  block: Block,
  key: string,
  withCaret: boolean,
  onResourceClick?: (link: ResourceLink) => void,
): ReactNode {
  const caret = withCaret ? (
    <span className="stream-caret" aria-hidden="true" />
  ) : null
  switch (block.kind) {
    case 'p':
      return (
        <p key={key} className="md-p">
          {renderInline(block.text, key, onResourceClick)}
          {caret}
        </p>
      )
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4'
      return (
        <Tag key={key} className={`md-h md-h${block.level}`}>
          {renderInline(block.text, key, onResourceClick)}
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
              {renderInline(item, `${key}-${index}`, onResourceClick)}
              {index === block.items.length - 1 && caret}
            </li>
          ))}
        </Tag>
      )
    }
    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {renderInline(block.text, key, onResourceClick)}
          {caret}
        </blockquote>
      )
    case 'table': {
      const alignOf = (cellIndex: number): Align =>
        block.aligns[cellIndex] ?? 'left'
      const [head, ...body] = block.rows
      const width = head.length
      const normalize = (row: string[]): string[] => {
        const cells = row.slice(0, width)
        while (cells.length < width) cells.push('')
        return cells
      }
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((cell, cellIndex) => (
                  <th key={cellIndex} style={{ textAlign: alignOf(cellIndex) }}>
                    {renderInline(
                      cell,
                      `${key}-h-${cellIndex}`,
                      onResourceClick,
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, rowIndex) => {
                const cells = normalize(row)
                return (
                  <tr key={rowIndex}>
                    {cells.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        style={{ textAlign: alignOf(cellIndex) }}
                      >
                        {renderInline(
                          cell,
                          `${key}-${rowIndex}-${cellIndex}`,
                          onResourceClick,
                        )}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {caret}
        </div>
      )
    }
    case 'hr':
      return <hr key={key} className="md-hr" />
  }
}

interface MessageMarkdownProps {
  text: string
  /** 流式进行中：在最后一个块尾追加闪烁光标。 */
  caret?: boolean
  /** 资源链接（workspace:// asset:// https://）点击回调；宿主按类型分发。 */
  onResourceClick?: (link: ResourceLink) => void
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
        renderBlock(
          block,
          `b${index}`,
          caret && index === lastIndex,
          props.onResourceClick,
        ),
      )}
      {blocks.length === 0 && caret && (
        <p className="md-p">
          <span className="stream-caret" aria-hidden="true" />
        </p>
      )}
    </div>
  )
}
