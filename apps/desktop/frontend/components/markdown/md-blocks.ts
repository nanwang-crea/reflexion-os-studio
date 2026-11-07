/**
 * 流式 Markdown 顶层块切分（性能 P0 的纯逻辑部分）：
 * 把渲染拆成"已完成的块前缀"与"仍在增长的尾块"，前者可缓存、只对后者重新
 * parse。切分点必须保守——只有"空行 + 下一非空行是独立块起始"才切，避免把
 * 松散列表、引用块、缩进代码、表格或 HTML 块拆成两段而改变渲染结果。
 */

/** 围栏代码块行（3 个以上 ` 或 ~，可带 info string）。 */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** 列表项行（无序或有序）。 */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
/** 引用块行。 */
const QUOTE_LINE = /^ {0,3}>/
/** 表格行。 */
const TABLE_LINE = /^ {0,3}\|/
/** HTML 块行。 */
const HTML_LINE = /^ {0,3}</
/** 链接/脚注引用定义行。 */
const REF_DEF_LINE = /^ {0,3}\[/
/** setext 下划线或分隔线。 */
const SETEXT_OR_RULE = /^ {0,3}(?:=+|-+)[ \t]*$/
/** 缩进 4 空格或制表符（缩进代码块 / 上一块的续行）。 */
const INDENTED = /^(?: {4,}|\t)/

interface FenceState {
  char: string
  length: number
}

interface LineInfo {
  /** 该行在原文中的起始偏移。 */
  start: number
  text: string
  /** 该行是否位于围栏代码块内部（含开启行本身）。 */
  fenceBefore: boolean
}

/** 行内围栏状态推进：只有独占一行的同字符、不短于开启符时才关闭。 */
function advanceFence(
  line: string,
  state: FenceState | null,
): FenceState | null {
  const match = FENCE_LINE.exec(line)
  if (match === null) return state
  const marker = match[1]
  const char = marker[0]
  if (state === null) return { char, length: marker.length }
  if (char !== state.char) return state
  if (marker.length < state.length) return state
  if (match[2].trim() !== '') return state
  return null
}

function scanLines(text: string): LineInfo[] {
  const infos: LineInfo[] = []
  let offset = 0
  let fence: FenceState | null = null
  for (;;) {
    const newline = text.indexOf('\n', offset)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(offset, end)
    infos.push({ start: offset, text: line, fenceBefore: fence !== null })
    fence = advanceFence(line, fence)
    if (newline === -1) break
    offset = end + 1
  }
  return infos
}

/** 该行能否作为独立顶层块的起始（成立时在其前面的空行处切分是安全的）。 */
function isIndependentBlockStart(line: string): boolean {
  if (line.trim() === '') return false
  if (INDENTED.test(line)) return false
  if (LIST_ITEM.test(line)) return false
  if (QUOTE_LINE.test(line)) return false
  if (TABLE_LINE.test(line)) return false
  if (HTML_LINE.test(line)) return false
  if (REF_DEF_LINE.test(line)) return false
  if (SETEXT_OR_RULE.test(line)) return false
  return true
}

/** 收集全部安全切分行索引（tail 起始行），按文本顺序返回。 */
function safeSplitStarts(infos: LineInfo[]): number[] {
  const starts: number[] = []
  let hasContent = false
  for (let index = 0; index < infos.length; index += 1) {
    const info = infos[index]
    if (info.fenceBefore) {
      hasContent = true
      continue
    }
    if (info.text.trim() !== '') {
      hasContent = true
      continue
    }
    if (!hasContent) continue
    let next = index + 1
    while (next < infos.length && infos[next].text.trim() === '') next += 1
    // 尾随空行之后没有内容：不能切，否则 caret 会挂到空尾块上。
    if (next >= infos.length) break
    if (infos[next].fenceBefore) continue
    if (!isIndependentBlockStart(infos[next].text)) continue
    starts.push(next)
  }
  return starts
}

export interface StreamingSplit {
  /** 已完成的块前缀（以安全切分点之后的空行结束）。 */
  head: string
  /** 仍在增长的尾块（可能为空字符串：整段都已完成时，尾部仍保留给 caret）。 */
  tail: string
}

/** 尾块切分：head + tail 恒等于原文，tail 从独立块起始行开始。 */
export function splitStreamingMarkdown(text: string): StreamingSplit {
  const infos = scanLines(text)
  const starts = safeSplitStarts(infos)
  if (starts.length === 0) return { head: '', tail: text }
  const at = infos[starts[starts.length - 1]].start
  return { head: text.slice(0, at), tail: text.slice(at) }
}

/** 把一段文本按同样的安全切分点拆成多个块（拼回原文）。 */
export function splitMarkdownBlocks(text: string): string[] {
  const infos = scanLines(text)
  const blocks: string[] = []
  let cursor = 0
  for (const index of safeSplitStarts(infos)) {
    const at = infos[index].start
    if (at <= cursor) continue
    const block = text.slice(cursor, at)
    if (block.trim() !== '') blocks.push(block)
    cursor = at
  }
  const rest = text.slice(cursor)
  if (rest.trim() !== '') blocks.push(rest)
  return blocks
}
