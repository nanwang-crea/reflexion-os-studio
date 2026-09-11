import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import { callSystem, optionalNumber, requireString } from './shared.js'
import { extractRevision, type FileReadState } from './read-state.js'

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
      '读取工作区内 UTF-8 文本文件，每行带绝对行号前缀（L<行号>: 内容），行号可直接用于资源链接 #L<行号> 引用；构造 file.edit 的 oldText 时必须去掉行号前缀。大文件用 offset（0 起始行号）+ limit 分段读；contentTruncated=true 时用同一 path 以 offset=nextOffset 继续读取（nextOffset 即最后一个已读行的行号）。path 为工作区相对路径，不允许绝对路径或 ..。编辑或覆盖文件前必须先用本工具读取目标文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径，如 src/app.ts' },
        offset: { type: 'number', description: '起始行号（0 起），缺省从头读' },
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
      if (modifiedMs !== undefined && revision !== undefined) {
        readState.record(path, { revision, complete: readComplete })
      }
      const window = buildNumberedWindow(content, startLine)
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
                ...(readComplete
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
      '按 glob 模式在工作区内递归查找文件路径。支持 **（跨目录）、* 与 ?（单段内）。结果带 truncated/nextOffset：truncated=true 时用同一 pattern 以 offset=nextOffset 续读，或缩小 pattern/limit。需要"找出所有某种文件"时优先用它而不是逐层 list。',
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
      },
      required: ['pattern'],
    },
    execute: ({ args, signal }) => {
      const params: Record<string, unknown> = {
        workspaceRoot,
        pattern: requireString(args, 'pattern'),
      }
      const offset = optionalNumber(args, 'offset')
      if (offset !== undefined) params.offset = Math.max(0, Math.trunc(offset))
      const limit = optionalNumber(args, 'limit')
      if (limit !== undefined) params.limit = Math.max(1, Math.trunc(limit))
      return callSystem(system, 'file.glob', params, signal)
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
      '在工作区文件内容中搜索字面子串（非正则），返回命中的 path/line/text。context>0 时每条命中附带前后上下文行（含行号，跳过本身命中的行），便于直接判断命中位置，减少后续 file.read。返回 truncated=true 时命中不完整，请使用更小的 glob 或缩小 maxResults 后分批搜索。可用 glob 参数缩小文件范围，ignoreCase 忽略大小写。二进制文件自动跳过。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要搜索的字面文本' },
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
      },
      required: ['text'],
    },
    execute: ({ args, signal }) => {
      const params: Record<string, unknown> = {
        workspaceRoot,
        text: requireString(args, 'text'),
      }
      const raw = args as Record<string, unknown>
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
      return callSystem(system, 'file.grep', params, signal)
    },
  }
}
