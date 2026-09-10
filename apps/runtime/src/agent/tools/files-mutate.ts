import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import { callSystem, optionalNumber, requireString } from './shared.js'
import { recordResultMtime, type FileReadState } from './read-state.js'

/**
 * 整文件写入的字符数预检：超过即折叠为自纠错误，引导模型改用 file.edit。
 * 若放行，超大 content 会先撑爆模型输出上限（arguments JSON 被截断 →
 * protocol_error 整个 Run 失败），预检把灾难性失败变成可恢复错误。
 */
const MAX_WRITE_CONTENT_CHARS = 200_000

/**
 * 写类文件工具：全部需要用户审批（grant 由审批网关注入，
 * Rust 侧 require_grant 兜底校验），路径一律限制在工作区内。
 * 先读后写强制与陈旧检测由 readToken（file.read 的 mtime 凭据）承载，
 * Rust 侧做最终校验；本层负责凭据的自动注入与回写，模型无需感知。
 */
export function createFileWriteTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  readState: FileReadState,
): ToolDefinition {
  return {
    name: 'file.write',
    description:
      '在工作区内写入/覆盖文本文件（自动创建父目录），返回写入字节数。覆盖已有文件前必须先用 file.read 读取当前内容（运行时强制校验，未读会被拒绝）；小改动优先用 file.edit；已有大文件不要整文件重写，用 file.edit 只替换变更片段。需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径' },
        content: { type: 'string', description: '完整文件内容（UTF-8 文本）' },
      },
      required: ['path', 'content'],
    },
    execute: ({ args, signal, grant }) => {
      const path = requireString(args, 'path')
      const content = requireString(args, 'content')
      if (content.length > MAX_WRITE_CONTENT_CHARS) {
        return Promise.resolve({
          content: `content 长度 ${content.length} 超过整文件写入上限 ${MAX_WRITE_CONTENT_CHARS} 字符。请改用 file.edit 只替换变更片段，或拆分多次写入。`,
          isError: true,
          code: 'invalid_request',
        })
      }
      const params: Record<string, unknown> = {
        workspaceRoot,
        path,
        content,
        grant: grant ?? '',
      }
      const readToken = readState.token(path)
      if (readToken !== undefined) {
        params.readToken = readToken
      }
      return callSystem(system, 'file.write', params, signal).then((result) => {
        if (!result.isError) {
          recordResultMtime(readState, path, result)
        }
        return result
      })
    },
  }
}

export function createFileEditTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  readState: FileReadState,
): ToolDefinition {
  return {
    name: 'file.edit',
    description:
      '对工作区内已有文本文件做精确替换：oldText → newText，只提交被替换的片段。oldText 必须逐字符复制自最近一次 file.read 读到的内容（不要凭记忆改写），在文件中出现的次数必须与 expectedCount（默认 1）一致，否则不写入并报错；运行时校验读取凭据，文件被外部修改过会要求重新读取。替换失败时先重新读取文件确认当前内容，再调整片段重试。需要用户审批。',
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
      const path = requireString(args, 'path')
      const readToken = readState.token(path)
      if (readToken === undefined) {
        return Promise.resolve({
          content: `尚未在本轮读取 ${path}：编辑前必须先用 file.read 读取该文件，并从返回内容中逐字符复制 oldText。`,
          isError: true,
          code: 'invalid_request',
        })
      }
      const params: Record<string, unknown> = {
        workspaceRoot,
        path,
        oldText: requireString(args, 'oldText'),
        newText: requireString(args, 'newText'),
        readToken,
        grant: grant ?? '',
      }
      const expectedCount = optionalNumber(args, 'expectedCount')
      if (expectedCount !== undefined) {
        params.expectedCount = Math.max(1, Math.trunc(expectedCount))
      }
      return callSystem(system, 'file.edit', params, signal).then((result) => {
        if (!result.isError) {
          recordResultMtime(readState, path, result)
        }
        return result
      })
    },
  }
}

export function createFileDeleteTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  readState: FileReadState,
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
    execute: ({ args, signal, grant }) => {
      const path = requireString(args, 'path')
      return callSystem(
        system,
        'file.delete',
        {
          workspaceRoot,
          path,
          grant: grant ?? '',
        },
        signal,
      ).then((result) => {
        if (!result.isError) {
          readState.invalidate([path])
        }
        return result
      })
    },
  }
}

export function createFileMoveTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  readState: FileReadState,
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
    execute: ({ args, signal, grant }) => {
      const from = requireString(args, 'from')
      const to = requireString(args, 'to')
      return callSystem(
        system,
        'file.move',
        {
          workspaceRoot,
          from,
          to,
          grant: grant ?? '',
        },
        signal,
      ).then((result) => {
        if (!result.isError) {
          readState.invalidate([from, to])
        }
        return result
      })
    },
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
