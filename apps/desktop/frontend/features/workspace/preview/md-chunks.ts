/**
 * Markdown 增量分块器（纯逻辑）：把按行分批读入的源文切为顶层块序列，
 * 供富预览按块渲染、按需追加。块边界只落在顶层空行处，块内允许包含
 * 多个 markdown 块级结构。
 * 等价性边界（已知不保证与整文渲染逐字一致的场景）：
 * - ``` / ~~~ 围栏内绝不切分（同字符且长度不小于开口才闭合）；
 * - 空行是潜在块边界，但切割决策推迟到下一条非空行出现时：
 *   空行前后的非空行均为列表项起始（或缩进续行）时不切，
 *   防止有序列表跨空行被切断后重新计数；
 * - 顶层 HTML 块跨空行、悬挂的链接引用定义等罕见结构可能被切开
 *   （渲染差异可接受）；
 * - 中文序号列表（`1、`）不是标准 GFM 语法，按普通段落渲染
 *   （旧手写渲染器曾识别，切换到 remark-gfm 后回归标准语义）。
 */

export interface MdChunkerState {
  /** 未完块的行（可含跨批悬挂的空行）。 */
  pending: string[]
  /** 围栏状态：null = 不在围栏内；否则记录开口字符与长度。 */
  fence: { char: string; len: number } | null
}

export function createMdChunkerState(): MdChunkerState {
  return { pending: [], fence: null }
}

const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/

function isBlankLine(line: string): boolean {
  return line.trim() === ''
}

function isListItemStart(line: string): boolean {
  return /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.test(line)
}

function isIndentedContinuation(line: string): boolean {
  return /^[ \t]{2,}\S/.test(line)
}

function isFenceClose(line: string, char: string, len: number): boolean {
  const body = line.replace(/^[ \t]{0,3}/, '')
  if (body.length < len) return false
  let index = 0
  while (index < body.length && body[index] === char) index++
  return index >= len && body.slice(index).trim() === ''
}

function lastNonBlank(lines: string[]): string | undefined {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!isBlankLine(lines[index])) return lines[index]
  }
  return undefined
}

/** 喂入一批行（不含换行符），返回本批内完成的块（跳过全空行块）。 */
export function feedMdLines(state: MdChunkerState, lines: string[]): string[] {
  const completed: string[] = []
  for (const line of lines) {
    if (state.fence !== null) {
      state.pending.push(line)
      if (isFenceClose(line, state.fence.char, state.fence.len)) {
        state.fence = null
      }
      continue
    }
    // 悬挂空行遇到非空行：现在有下文，可以决定上一块的边界了。
    const pendingTail = state.pending[state.pending.length - 1] ?? ''
    if (!isBlankLine(line) && isBlankLine(pendingTail)) {
      const prev = lastNonBlank(state.pending)
      const keepTogether =
        prev !== undefined &&
        isListItemStart(prev) &&
        (isListItemStart(line) || isIndentedContinuation(line))
      if (!keepTogether && state.pending.some((item) => !isBlankLine(item))) {
        completed.push(state.pending.join('\n'))
        state.pending = []
      }
    }
    const open = FENCE_OPEN_RE.exec(line)
    if (open !== null) {
      state.fence = { char: open[1][0], len: open[1].length }
    }
    state.pending.push(line)
  }
  return completed
}

/** 文件读尽：把未完块冲出（全空行时返回空数组）。 */
export function flushMdChunks(state: MdChunkerState): string[] {
  const block = state.pending.join('\n')
  state.pending = []
  state.fence = null
  return block.trim() === '' ? [] : [block]
}
