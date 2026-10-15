import { createHash } from 'node:crypto'
import type {
  ToolDefinition,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import {
  FileWriteStreamInputSchema,
  FileWriteBeginResultSchema,
  FileWriteAppendResultSchema,
  fileWriteStreamParameters,
  type FileWriteCheckpoint,
  type JsonValue,
} from '@reflexion-os-studio/contracts'
import type { SystemRuntimeClient } from '../../../system.js'
import { callSystem } from '../shared.js'
import {
  normalizedPathKey,
  recordResultRevision,
  type FileReadState,
} from '../read-state.js'
import { fileWriteProgress } from './state.js'

const MAX_CHUNK_BYTES = 512 * 1024

function invalid(content: string): ToolResult {
  return { content, isError: true, code: 'invalid_request' }
}

/** Persist the private protocol checkpoint in canonical data, not model text. */
function success(
  state: FileWriteCheckpoint,
  result: Record<string, JsonValue> = {},
): ToolResult {
  const progress = fileWriteProgress(state)
  return {
    content: JSON.stringify({ ...result, ...progress }),
    isError: false,
    data: { ...result, fileWriteCheckpoint: state },
  }
}

export function createFileWriteStreamTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  readState: FileReadState,
  states = new Map<string, FileWriteCheckpoint>(),
): ToolDefinition {
  return {
    name: 'file.write_stream',
    description:
      '通用 UTF-8 大文件写入（代码、文档、JSON、CSV 等）：begin(path)，append(path, chunkIndex 从 0 连续递增, title, content)，最后 commit(path)。文本块内容原样拼接，请自行包含所需分隔符和换行；title 仅作可选进度标签，不写入文件。Runtime 管理上传句柄与偏移；记不清进度用 status(path) 或重复 begin，不要重新生成已接收文本块。同序号同内容可安全重试，不同内容拒绝。commit 前目标不变，abort 清理草稿；完成后重写须先 abort 再 begin。每个文件最多 4096 块，总计最多 512MiB，每块最多 512KiB；建议每块数千字符，按自然边界分块，无需章节结构。覆盖前先 file.read。',
    parameters: fileWriteStreamParameters,
    execute: async ({ args, signal, grant }) => {
      const parsed = FileWriteStreamInputSchema.safeParse(args)
      if (!parsed.success) return invalid(parsed.error.message)
      const { action, path, chunkIndex, title, content } = parsed.data
      if (
        action !== 'append' &&
        (chunkIndex !== undefined ||
          title !== undefined ||
          content !== undefined)
      )
        return invalid('只有 append 可携带 chunkIndex、title、content。')
      const key = normalizedPathKey(path)
      let state = states.get(key)
      const invoke = (params: Record<string, unknown>) =>
        callSystem(
          system,
          'file.write_stream',
          {
            workspaceRoot,
            path,
            grant: grant ?? '',
            ...params,
          },
          signal,
        )
      if (action === 'begin') {
        if (state && state.phase !== 'aborted') return success(state)
        const entry = readState.entry(path)
        const result = await invoke({ action, revision: entry?.revision })
        if (result.isError) return result
        const response = FileWriteBeginResultSchema.parse(
          JSON.parse(result.content),
        )
        state = {
          version: 1,
          workspaceRoot,
          path,
          uploadId: response.uploadId,
          nextOffset: response.nextOffset,
          phase: 'active',
          chunks: [],
        }
        states.set(key, state)
        return success(state)
      }
      if (state && action === 'status') return success(state)
      if (state?.phase === 'aborted' && action === 'abort')
        return success(state)
      if (!state || state.phase === 'aborted')
        return invalid('没有活动写入，请先 begin(path)。')
      if (action === 'commit' && state.phase === 'committed')
        return success(state)
      if (action === 'abort' && state.phase === 'committed') {
        state = { ...state, phase: 'aborted' }
        states.set(key, state)
        return success(state)
      }
      if (state.phase !== 'active')
        return invalid('文件已提交；重写须先 abort 再 begin。')
      if (action === 'append') {
        if (chunkIndex === undefined || content === undefined)
          return invalid('append 需要 chunkIndex 和 content。')
        const bytes = Buffer.byteLength(content, 'utf8')
        if (state.chunks.length >= 4096 && !state.chunks[chunkIndex])
          return invalid(
            '每个文件最多 4096 块，请先提交，再用 file.edit 修改。',
          )
        if (bytes > MAX_CHUNK_BYTES)
          return invalid(`文本块超过 ${MAX_CHUNK_BYTES} bytes，请拆小。`)
        const sha256 = createHash('sha256')
          .update(content, 'utf8')
          .digest('hex')
        const previous = state.chunks[chunkIndex]
        if (previous) {
          return previous.sha256 === sha256
            ? success(state)
            : invalid(
                '此文本块已接收但内容不同；请用 status 核对，禁止重复追加。',
              )
        }
        if (state.nextOffset + bytes > 512 * 1024 * 1024)
          return invalid('文件超过 512MiB 上限。')
        if (chunkIndex !== state.chunks.length)
          return invalid(
            `文本块乱序；下一块 chunkIndex=${state.chunks.length}。`,
          )
        const result = await invoke({
          action,
          uploadId: state.uploadId,
          offset: state.nextOffset,
          content,
          chunkSha256: sha256,
        })
        if (result.isError) return result
        const response = FileWriteAppendResultSchema.parse(
          JSON.parse(result.content),
        )
        if (response.nextOffset !== state.nextOffset + bytes)
          return invalid('写入进度不一致，请保留当前块并重试，禁止跳过。')
        state = {
          ...state,
          nextOffset: response.nextOffset,
          chunks: [
            ...state.chunks,
            { index: chunkIndex, title: title ?? '', sha256, bytes },
          ],
        }
        states.set(key, state)
        return success(state)
      }
      const result = await invoke({
        action,
        uploadId: state.uploadId,
        ...(action === 'commit' ? { expectedSize: state.nextOffset } : {}),
      })
      if (result.isError) return result
      if (action === 'commit') recordResultRevision(readState, path, result)
      state = { ...state, phase: action === 'commit' ? 'committed' : 'aborted' }
      states.set(key, state)
      return success(
        state,
        JSON.parse(result.content) as Record<string, JsonValue>,
      )
    },
  }
}
