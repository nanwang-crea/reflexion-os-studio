import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import { callSystem, optionalNumber, requireString } from './shared.js'

/**
 * 写类文件工具：全部需要用户审批（grant 由审批网关注入，
 * Rust 侧 require_grant 兜底校验），路径一律限制在工作区内。
 */
export function createFileWriteTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.write',
    description:
      '在工作区内写入/覆盖文本文件（自动创建父目录），返回写入字节数。小改动优先用 file.edit。需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径' },
        content: { type: 'string', description: '完整文件内容（UTF-8 文本）' },
      },
      required: ['path', 'content'],
    },
    execute: ({ args, signal, grant }) =>
      callSystem(
        system,
        'file.write',
        {
          workspaceRoot,
          path: requireString(args, 'path'),
          content: requireString(args, 'content'),
          grant: grant ?? '',
        },
        signal,
      ),
  }
}

export function createFileEditTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.edit',
    description:
      '对工作区内已有文本文件做精确替换：oldText → newText，只提交被替换的片段。oldText 在文件中出现的次数必须与 expectedCount（默认 1）一致，否则不写入并报错。需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径' },
        oldText: {
          type: 'string',
          description: '要被替换的原文片段（需与文件内容逐字符一致）',
        },
        newText: {
          type: 'string',
          description: '替换后的内容，可为空串表示删除',
        },
        expectedCount: {
          type: 'number',
          description: 'oldText 应出现的次数，缺省 1；多处相同片段时必须写明',
        },
      },
      required: ['path', 'oldText', 'newText'],
    },
    execute: ({ args, signal, grant }) => {
      const params: Record<string, unknown> = {
        workspaceRoot,
        path: requireString(args, 'path'),
        oldText: requireString(args, 'oldText'),
        newText: requireString(args, 'newText'),
        grant: grant ?? '',
      }
      const expectedCount = optionalNumber(args, 'expectedCount')
      if (expectedCount !== undefined) {
        params.expectedCount = Math.max(1, Math.trunc(expectedCount))
      }
      return callSystem(system, 'file.edit', params, signal)
    },
  }
}

export function createFileDeleteTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.delete',
    description:
      '删除工作区内的文件或目录（目录递归删除，workspace 根不可删）。不可逆，仅在明确要求时使用。需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径（文件或目录）' },
      },
      required: ['path'],
    },
    execute: ({ args, signal, grant }) =>
      callSystem(
        system,
        'file.delete',
        {
          workspaceRoot,
          path: requireString(args, 'path'),
          grant: grant ?? '',
        },
        signal,
      ),
  }
}

export function createFileMoveTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.move',
    description:
      '在工作区内移动/重命名文件或目录（目标已存在则报错）。需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源路径（工作区相对）' },
        to: { type: 'string', description: '目标路径（工作区相对）' },
      },
      required: ['from', 'to'],
    },
    execute: ({ args, signal, grant }) =>
      callSystem(
        system,
        'file.move',
        {
          workspaceRoot,
          from: requireString(args, 'from'),
          to: requireString(args, 'to'),
          grant: grant ?? '',
        },
        signal,
      ),
  }
}

export function createFileMkdirTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.mkdir',
    description: '在工作区内创建目录（递归创建父目录）。需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对目录路径' },
      },
      required: ['path'],
    },
    execute: ({ args, signal, grant }) =>
      callSystem(
        system,
        'file.mkdir',
        {
          workspaceRoot,
          path: requireString(args, 'path'),
          grant: grant ?? '',
        },
        signal,
      ),
  }
}
