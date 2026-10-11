import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import { callSystem, optionalNumber, requireString } from './shared.js'
import { extractRevision, type FileReadState } from './read-state.js'
import { decodeSearchCursor, encodeSearchCursor } from './search-cursor.js'

/**
 * 单次回填的带行号内容字符预算：给元数据与截断提示留出余量（模型上限 16K）。
 * 超预算在行边界截断并显式给出 nextOffset——行对齐分页使"已返回行数"可数，
 * 通用字符截断层对 file.read 不再触发（其 head+tail 省略会留下中间空洞）。
 */
const READ_CONTENT_BUDGET_CHARS = 12_000

/** 带行号窗口：content 为 `L<绝对行号>: 内容`（1-based，对应资源链接 #L 行号）。 */
interface NumberedWindow {
  content: string
  returnedLines: number
  contentTruncated: boolean
  nextOffset?: number
}

function buildNumberedWindow(
  content: string,
  startLine: number,
): NumberedWindow {
  if (content === '') {
    return { content: '', returnedLines: 0, contentTruncated: false }
  }
  const lines = content.split('\n')
  const numbered: string[] = []
  let used = 0
  let contentTruncated = false
  for (let index = 0; index < lines.length; index += 1) {
    const formatted = `L${startLine + index + 1}: ${lines[index]}`
    if (formatted.length > READ_CONTENT_BUDGET_CHARS) {
      // 单行超预算（如 minified 文件）：至少包含部分内容，避免空窗口。
      numbered.push(
        `${formatted.slice(0, READ_CONTENT_BUDGET_CHARS)}…（单行超长已截断）`,
      )
      contentTruncated = true
      break
    }
    if (used + formatted.length > READ_CONTENT_BUDGET_CHARS) {
      contentTruncated = true
      break
    }
    numbered.push(formatted)
    used += formatted.length
  }
  const returnedLines = numbered.length
  if (contentTruncated) {
    return {
      // nextOffset（0-based 参数）恰好等于最后一个已读行的 L 行号。
      content: `${numbered.join('\n')}\n…（本窗口已按行预算截断）`,
      returnedLines,
      contentTruncated: true,
      nextOffset: startLine + returnedLines,
    }
  }
  return {
    content: numbered.join('\n'),
    returnedLines,
    contentTruncated: false,
  }
}

/** 只读类文件工具：读取（行号 + 行对齐分页）、列表、glob 匹配、grep 文本搜索。 */
export function createFileReadTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  readState: FileReadState,
): ToolDefinition {
  return {
    name: 'file.read',
    description:
      '读取工作区内 UTF-8 文本文件，每行带 1 起始绝对行号前缀（L<行号>: 内容），行号可直接用于资源链接 #L<行号> 或 file.edit.replace_range 的 startLine/endLine，不要减 1。例如替换 L93 到 L94，应传 startLine=93、endLine=94。file.edit 会安全去除匹配文本的行号前缀。大文件用 offset（0 起始的跳过行数，不是编辑行号）+ limit 分段读；contentTruncated=true 时用同一 path 以 offset=nextOffset 继续读取（nextOffset 即最后一个已读行的行号）。path 为工作区相对路径，不允许绝对路径或 ..。编辑或覆盖文件前必须先用本工具读取目标文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径，如 src/app.ts' },
        offset: {
          type: 'number',
          description: '跳过的行数（0 起），缺省 0；读取 L93 从 offset=92 开始',
        },
        limit: { type: 'number', description: '本次最多读取的行数，缺省 2000' },
      },
      required: ['path'],
    },
    execute: async ({ args, signal }) => {
      const path = requireString(args, 'path')
      const params: Record<string, unknown> = {
        workspaceRoot,
        path,
      }
      const offset = optionalNumber(args, 'offset')
      const limit = optionalNumber(args, 'limit')
      if (offset !== undefined) params.offset = Math.max(0, Math.trunc(offset))
      if (limit !== undefined) params.limit = Math.max(1, Math.trunc(limit))
      const raw = await callSystem(system, 'file.read', params, signal)
      if (raw.isError) return raw
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.content)
      } catch {
        return raw
      }
      if (typeof parsed !== 'object' || parsed === null) return raw
      const record = parsed as Record<string, unknown>
      const content = typeof record.content === 'string' ? record.content : ''
      const startLine = typeof record.offset === 'number' ? record.offset : 0
      const totalLines =
        typeof record.totalLines === 'number' ? record.totalLines : 0
      const sizeBytes =
        typeof record.sizeBytes === 'number' ? record.sizeBytes : 0
      const modifiedMs =
        typeof record.modifiedMs === 'number' ? record.modifiedMs : undefined
      const revision = extractRevision(record)
      const readComplete = record.readComplete === true
      const window = buildNumberedWindow(content, startLine)
      const complete =
        startLine === 0 && readComplete && !window.contentTruncated
      if (modifiedMs !== undefined && revision !== undefined) {
        readState.record(path, { revision, complete })
      }
      const result: Record<string, unknown> = {
        path,
        sizeBytes,
        totalLines,
        offset: startLine,
        returnedLines: window.returnedLines,
        contentTruncated: window.contentTruncated,
        ...(window.contentTruncated
          ? {
              nextOffset: window.nextOffset,
              hint: 'content 已按单次字符预算行对齐截断：用同一 path 以 offset=nextOffset 继续读取',
            }
          : {}),
        ...(modifiedMs !== undefined ? { modifiedMs } : {}),
        ...(revision !== undefined
          ? {
              revision,
              // 覆盖文件（file.write）必须基于未截断的完整读取：
              // 分页窗口发出的凭据只满足 file.edit 的先读要求。
              ...(complete
                ? {}
                : {
                    revisionHint:
                      '本窗口为分页读取，凭据仅可用于 file.edit；覆盖文件需完整读取（读至无截断）后再 file.write',
                  }),
            }
          : {}),
        content: window.content,
      }
      return { content: JSON.stringify(result), isError: false }
    },
  }
}

export function createFileListTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.list',
    description:
      '列出工作区内目录的条目（path/kind/sizeBytes）。recursive=true 时递归展开子目录。path 为工作区相对路径，"." 表示根目录。结果带 returnedCount/truncated/nextOffset：truncated=true 表示结果不完整，应保持同一 path 与 recursive，用 offset=nextOffset 再次调用本工具续读剩余条目，或改用 file.glob/缩小范围。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对目录路径' },
        recursive: { type: 'boolean', description: '是否递归列出子目录' },
        offset: {
          type: 'number',
          description: '起始偏移量（0 起），缺省从头开始',
        },
        limit: {
          type: 'number',
          description: '本次最多返回条数，缺省 200；服务端仍受上限约束',
        },
      },
      required: ['path'],
    },
    execute: async ({ args, signal }) => {
      const params: Record<string, unknown> = {
        workspaceRoot,
        path: requireString(args, 'path'),
      }
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        if ((args as Record<string, unknown>).recursive === true) {
          params.recursive = true
        }
      }
      const offset = optionalNumber(args, 'offset')
      if (offset !== undefined) params.offset = Math.max(0, Math.trunc(offset))
      const limit = optionalNumber(args, 'limit')
      if (limit !== undefined) params.limit = Math.max(1, Math.trunc(limit))
      return callSystem(system, 'file.list', params, signal)
    },
  }
}

export function createFileGlobTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.glob',
    description:
      '按 glob 模式在工作区内递归查找文件路径。支持 **、*、?、字符类与 {ts,tsx} 展开；遵循 .gitignore，不跟随符号链接。结果包含 scannedFiles、scanTruncated、actualGlob 与分页信息；truncated=true 时用 nextOffset 或 nextCursor 继续，scanTruncated=true 表示达到遍历上限。需要"找出所有某种文件"时优先使用本工具。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '工作区相对 glob 模式，如 **/*.xlsx 或 docs/*.md',
        },
        offset: {
          type: 'number',
          description: '起始偏移量（0 起），缺省从头开始',
        },
        limit: { type: 'number', description: '最多返回条数，缺省 500' },
        cursor: {
          type: 'string',
          description: '上次结果返回的不透明续读 cursor',
        },
      },
      required: ['pattern'],
    },
    execute: async ({ args, signal }) => {
      const pattern = requireString(args, 'pattern')
      const params: Record<string, unknown> = {
        workspaceRoot,
        pattern,
      }
      const raw = args as Record<string, unknown>
      const offset =
        decodeSearchCursor(raw.cursor, 'glob', pattern) ??
        optionalNumber(args, 'offset')
      if (offset !== undefined) params.offset = Math.max(0, Math.trunc(offset))
      const limit = optionalNumber(args, 'limit')
      if (limit !== undefined) params.limit = Math.max(1, Math.trunc(limit))
      const result = await callSystem(system, 'file.glob', params, signal)
      return withSearchCursor(result, 'glob', pattern)
    },
  }
}

export function createFileGrepTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.grep',
    description:
      '在工作区文件内容中使用正则表达式搜索，返回命中的 path/line/text。支持 foo|bar、function\\s+\\w+ 等模式；搜索普通文本但包含正则符号时设置 literal=true。glob 可缩小范围，不含 / 的模式（如 *.rs）匹配任意目录文件名。搜索遵循 .gitignore、不跟随符号链接并硬拒绝凭据路径；结果包含 scannedFiles、scanTruncated、actualGlob、ignoreCase 与分页信息，便于判断空命中是否完整。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '要搜索的正则表达式，如 foo|bar 或 function\\s+\\w+',
        },
        text: {
          type: 'string',
          description: '兼容旧调用；新调用请使用 pattern',
        },
        literal: {
          type: 'boolean',
          description: '将 pattern 作为普通文本而非正则表达式，缺省 false',
        },
        glob: {
          type: 'string',
          description: '可选，仅扫描命中该 glob 的文件，如 *.rs',
        },
        ignoreCase: { type: 'boolean', description: '是否忽略大小写' },
        context: {
          type: 'number',
          description: '命中行前后各附带的上下文行数（0-5），缺省 0',
        },
        maxResults: {
          type: 'number',
          description: '最多返回命中条数，缺省 200',
        },
        cursor: {
          type: 'string',
          description: '上次结果返回的不透明续读 cursor',
        },
      },
    },
    execute: async ({ args, signal }) => {
      const raw = args as Record<string, unknown>
      const pattern = resolveGrepPattern(raw)
      const params: Record<string, unknown> = {
        workspaceRoot,
        pattern,
      }
      if (raw.literal === true) params.literal = true
      if (typeof raw.glob === 'string' && raw.glob.trim() !== '') {
        params.glob = raw.glob
      }
      if (raw.ignoreCase === true) params.ignoreCase = true
      const context = optionalNumber(args, 'context')
      if (context !== undefined && context > 0) {
        params.context = Math.min(5, Math.trunc(context))
      }
      const maxResults = optionalNumber(args, 'maxResults')
      if (maxResults !== undefined) {
        params.maxResults = Math.max(1, Math.trunc(maxResults))
      }
      const fingerprint = JSON.stringify([
        pattern,
        params.glob ?? null,
        raw.ignoreCase === true,
        raw.literal === true,
        params.context ?? 0,
      ])
      const offset = decodeSearchCursor(raw.cursor, 'grep', fingerprint)
      if (offset !== undefined) params.offset = offset
      const result = await callSystem(system, 'file.grep', params, signal)
      return withSearchCursor(result, 'grep', fingerprint)
    },
  }
}

/** pattern 与旧 text 至少一个非空；两者都非空且不相等时拒绝，避免静默搜错内容。 */
function resolveGrepPattern(args: Record<string, unknown>): string {
  const pattern = typeof args.pattern === 'string' ? args.pattern : undefined
  const text = typeof args.text === 'string' ? args.text : undefined
  const patternUsable = pattern !== undefined && pattern.trim() !== ''
  const textUsable = text !== undefined && text.trim() !== ''
  if (patternUsable && textUsable && pattern !== text) {
    throw new Error(
      'file.grep pattern and text differ; pass only one search expression',
    )
  }
  if (patternUsable) return pattern
  if (textUsable) return text
  throw new Error('file.grep requires pattern or legacy text')
}

function withSearchCursor(
  result: Awaited<ReturnType<typeof callSystem>>,
  tool: 'glob' | 'grep',
  fingerprint: string,
) {
  if (result.isError) return result
  try {
    const data = JSON.parse(result.content) as Record<string, unknown>
    if (typeof data.nextOffset === 'number')
      data.nextCursor = encodeSearchCursor(tool, fingerprint, data.nextOffset)
    return { ...result, content: JSON.stringify(data) }
  } catch {
    return result
  }
}
