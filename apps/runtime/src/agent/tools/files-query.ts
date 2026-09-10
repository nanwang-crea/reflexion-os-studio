import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import { callSystem, optionalNumber, requireString } from './shared.js'
import type { FileReadState } from './read-state.js'

/** 只读类文件工具：读取（分段）、列表（递归）、glob 匹配、grep 文本搜索。 */
export function createFileReadTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  readState: FileReadState,
): ToolDefinition {
  return {
    name: 'file.read',
    description:
      '读取工作区内 UTF-8 文本文件的内容（含 sizeBytes/totalLines）。大文件用 offset（0 起始行号）+ limit 分段读；若 totalLines 大于 offset+返回行数，用同一 path 以 offset=offset+返回行数继续读取。path 为工作区相对路径，不允许绝对路径或 ..。编辑或覆盖文件前必须先用本工具读取目标文件。',
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
      if (!raw.isError) {
        try {
          const parsed: unknown = JSON.parse(raw.content)
          if (typeof parsed === 'object' && parsed !== null) {
            const modifiedMs = (parsed as Record<string, unknown>).modifiedMs
            if (typeof modifiedMs === 'number') {
              readState.record(path, modifiedMs)
            }
          }
        } catch {
          // 非 JSON 结果不记录凭据；后续编辑会被先读校验拦下并可自纠。
        }
      }
      return raw
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
      const raw = await callSystem(system, 'file.list', params, signal)
      if (!raw.isError) {
        try {
          const parsed: unknown = JSON.parse(raw.content)
          raw.content = stringifyListResult(parsed)
        } catch {
          // 非 JSON 结果原样保留，由通用字符截断提示兜底。
        }
      }
      return raw
    },
  }
}

/**
 * 序列化 Rust ListResult 时把截断元数据（returnedCount/truncated/nextOffset）放在
 * entries 之前：模型可见结果超过字符上限被二次截断时，续读信息不会被切掉，
 * 而不是被通用的"结果过长已截断"提示掩盖。
 */
function stringifyListResult(result: unknown): string {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return JSON.stringify(result)
  }
  const record = result as Record<string, unknown>
  const { entries, ...metadata } = record
  return JSON.stringify({ ...metadata, entries })
}

export function createFileGlobTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.glob',
    description:
      '按 glob 模式在工作区内递归查找文件路径。返回 truncated=true 时结果不完整，请缩小 pattern 或降低范围后再次调用；支持 **（跨目录）、* 与 ?（单段内）。需要"找出所有某种文件"时优先用它而不是逐层 list。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '工作区相对 glob 模式，如 **/*.xlsx 或 docs/*.md',
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
      '在工作区文件内容中搜索字面子串（非正则），返回命中的 path/line/text。返回 truncated=true 时命中不完整，请使用更小的 glob 或缩小 maxResults 后分批搜索。可用 glob 参数缩小文件范围，ignoreCase 忽略大小写。二进制文件自动跳过。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要搜索的字面文本' },
        glob: {
          type: 'string',
          description: '可选，仅扫描命中该 glob 的文件，如 *.rs',
        },
        ignoreCase: { type: 'boolean', description: '是否忽略大小写' },
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
      const maxResults = optionalNumber(args, 'maxResults')
      if (maxResults !== undefined) {
        params.maxResults = Math.max(1, Math.trunc(maxResults))
      }
      return callSystem(system, 'file.grep', params, signal)
    },
  }
}
