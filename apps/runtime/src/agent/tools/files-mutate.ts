import { createHash } from 'node:crypto'
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import {
  argsRecord,
  callSystem,
  optionalNumber,
  optionalString,
  requireString,
  requireText,
} from './shared.js'
import { recordResultRevision, type FileReadState } from './read-state.js'
import { parseEditOperation } from './edit-operations.js'

/**
 * 整文件写入的字符数预检：超过即折叠为自纠错误，引导模型改用 file.edit。
 * 若放行，超大 content 会先撑爆模型输出上限（arguments JSON 被截断 →
 * protocol_error 整个 Run 失败），预检把灾难性失败变成可恢复错误。
 */
const MAX_WRITE_CONTENT_CHARS = 200_000
const MAX_STREAM_CHUNK_BYTES = 512 * 1024

/**
 * 写类文件工具：全部需要用户审批（grant 由审批网关注入，
 * Rust 侧 require_grant 兜底校验），路径一律限制在工作区内。
 * 先读后写强制与陈旧检测由 revision（mtime+size+sha256 三字段凭据）承载，
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
      const content = requireText(args, 'content')
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
      const entry = readState.entry(path)
      if (entry !== undefined && !entry.complete) {
        return Promise.resolve({
          content: `${path} 的读取凭据来自分页窗口，不足以覆盖整文件：请继续用 offset=nextOffset 读取至 contentTruncated=false（或重新完整读取）后再 file.write。新建文件可直接写入。`,
          isError: true,
          code: 'invalid_request',
        })
      }
      if (entry !== undefined) {
        params.revision = entry.revision
      }
      return callSystem(system, 'file.write', params, signal).then((result) => {
        if (!result.isError) {
          recordResultRevision(readState, path, result)
        }
        return result
      })
    },
  }
}

export function createFileWriteStreamTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  readState: FileReadState,
): ToolDefinition {
  return {
    name: 'file.write_stream',
    description:
      '可恢复地分块写入大型 UTF-8 文件。按 begin → 多次 append → commit 调用；每次 append 必须使用上次返回的 nextOffset。commit 前目标文件保持不变，abort 可清理 staging。覆盖已有文件前必须先 file.read 获取 revision。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['begin', 'append', 'commit', 'abort'],
        },
        path: { type: 'string', description: '工作区相对路径' },
        uploadId: { type: 'string', minLength: 64, maxLength: 64 },
        offset: { type: 'integer', minimum: 0 },
        content: { type: 'string', description: '本次 UTF-8 文本分块' },
        expectedSize: { type: 'integer', minimum: 0 },
        expectedSha256: { type: 'string', minLength: 64, maxLength: 64 },
      },
      required: ['action', 'path'],
    },
    execute: ({ args, signal, grant }) => {
      const action = requireString(args, 'action')
      const path = requireString(args, 'path')
      const params: Record<string, unknown> = {
        workspaceRoot,
        path,
        action,
        grant: grant ?? '',
      }
      if (action === 'begin') {
        const entry = readState.entry(path)
        if (entry !== undefined) params.revision = entry.revision
      } else {
        params.uploadId = requireString(args, 'uploadId')
      }
      if (action === 'append') {
        const content = requireText(args, 'content')
        const bytes = Buffer.from(content, 'utf8')
        if (bytes.byteLength > MAX_STREAM_CHUNK_BYTES) {
          return Promise.resolve({
            content: `分块为 ${bytes.byteLength} bytes，超过 ${MAX_STREAM_CHUNK_BYTES} bytes 上限。`,
            isError: true,
            code: 'invalid_request',
          })
        }
        const offset = optionalNumber(args, 'offset')
        if (offset === undefined || !Number.isSafeInteger(offset) || offset < 0)
          throw new Error('append requires a non-negative integer offset')
        params.offset = offset
        params.content = content
        params.chunkSha256 = createHash('sha256').update(bytes).digest('hex')
      } else if (action === 'commit') {
        const expectedSize = optionalNumber(args, 'expectedSize')
        if (expectedSize !== undefined) params.expectedSize = expectedSize
        const expectedSha256 = optionalString(args, 'expectedSha256')
        if (expectedSha256 !== undefined) params.expectedSha256 = expectedSha256
      } else if (action !== 'begin' && action !== 'abort') {
        throw new Error('invalid stream write action')
      }
      return callSystem(system, 'file.write_stream', params, signal).then(
        (result) => {
          if (!result.isError && action === 'commit')
            recordResultRevision(readState, path, result)
          return result
        },
      )
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
      '原子编辑工作区内单个文本文件。优先传 edits 数组，可组合 replace、insert_before、insert_after、replace_range；全部操作基于同一原始快照校验，任一失败或重叠则完全不写入。replace_range 的 startLine/endLine 均为 1 起始且包含首尾，直接使用 file.read 的 L 行号，不要减 1；必须同时提供 expectedText，不能只凭行号修改。旧版 oldText/newText 参数仍兼容。匹配文本可直接复制 file.read 返回内容，运行时会安全去除 L<行号>: 前缀。需要用户审批。',
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
        edits: {
          type: 'array',
          description: '同一文件上的原子编辑列表；与 oldText/newText 二选一',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'replace',
                  'insert_before',
                  'insert_after',
                  'replace_range',
                ],
              },
              oldText: { type: 'string' },
              newText: { type: 'string' },
              anchor: { type: 'string' },
              content: { type: 'string' },
              expectedCount: { type: 'number' },
              startLine: {
                type: 'integer',
                minimum: 1,
                description:
                  'replace_range 起始行（1 起，包含）；直接使用 file.read 的 L 行号，不要减 1',
              },
              endLine: {
                type: 'integer',
                minimum: 1,
                description:
                  'replace_range 结束行（1 起，包含），必须 >= startLine；L93–L94 对应 startLine=93、endLine=94',
              },
              expectedText: {
                type: 'string',
                description:
                  'replace_range 范围内的完整原文，行间保留换行，不含结束行后的换行；可复制 file.read 的 L 行号前缀，校验不匹配则完全不写入',
              },
            },
            required: ['kind'],
          },
        },
      },
      required: ['path'],
    },
    execute: ({ args, signal, grant }) => {
      const path = requireString(args, 'path')
      const entry = readState.entry(path)
      if (entry === undefined) {
        return Promise.resolve({
          content: `尚未在本轮读取 ${path}：编辑前必须先用 file.read 读取该文件，并从返回内容中逐字符复制 oldText。`,
          isError: true,
          code: 'invalid_request',
        })
      }
      const params: Record<string, unknown> = {
        workspaceRoot,
        path,
        revision: entry.revision,
        grant: grant ?? '',
      }
      const record = argsRecord(args)
      if (Array.isArray(record.edits)) {
        if (record.edits.length === 0) {
          throw new Error('edits must not be empty')
        }
        params.edits = record.edits.map(parseEditOperation)
      } else {
        params.oldText = requireString(args, 'oldText')
        params.newText = requireText(args, 'newText')
        const expectedCount = optionalNumber(args, 'expectedCount')
        if (expectedCount !== undefined) {
          params.expectedCount = Math.max(1, Math.trunc(expectedCount))
        }
      }
      return callSystem(system, 'file.edit', params, signal).then((result) => {
        if (!result.isError) {
          recordResultRevision(readState, path, result)
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
