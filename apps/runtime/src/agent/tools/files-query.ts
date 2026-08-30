import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import { callSystem, optionalNumber, requireString } from './shared.js'

/** 只读类文件工具：读取（分段）、列表（递归）、glob 匹配、grep 文本搜索。 */
export function createFileReadTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.read',
    description:
      '读取工作区内 UTF-8 文本文件的内容（含 sizeBytes/totalLines）。大文件用 offset（0 起始行号）+ limit 分段读。path 为工作区相对路径，不允许绝对路径或 ..。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径，如 src/app.ts' },
        offset: { type: 'number', description: '起始行号（0 起），缺省从头读' },
        limit: { type: 'number', description: '本次最多读取的行数，缺省 2000' },
      },
      required: ['path'],
    },
    execute: ({ args, signal }) => {
      const params: Record<string, unknown> = {
        workspaceRoot,
        path: requireString(args, 'path'),
      }
      const offset = optionalNumber(args, 'offset')
      const limit = optionalNumber(args, 'limit')
      if (offset !== undefined) params.offset = Math.max(0, Math.trunc(offset))
      if (limit !== undefined) params.limit = Math.max(1, Math.trunc(limit))
      return callSystem(system, 'file.read', params, signal)
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
      '列出工作区内目录的条目（path/kind/sizeBytes）。recursive=true 时递归展开子目录。path 为工作区相对路径，"." 表示根目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对目录路径' },
        recursive: { type: 'boolean', description: '是否递归列出子目录' },
      },
      required: ['path'],
    },
    execute: ({ args, signal }) => {
      const params: Record<string, unknown> = {
        workspaceRoot,
        path: requireString(args, 'path'),
      }
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        if ((args as Record<string, unknown>).recursive === true) {
          params.recursive = true
        }
      }
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
      '按 glob 模式在工作区内递归查找文件路径。支持 **（跨目录）、* 与 ?（单段内）。需要"找出所有某种文件"时优先用它而不是逐层 list。',
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
      '在工作区文件内容中搜索字面子串（非正则），返回命中的 path/line/text。可用 glob 参数缩小文件范围，ignoreCase 忽略大小写。二进制文件自动跳过。',
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
