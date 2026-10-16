import {
  FileEditArgumentGuidance,
  FileEditInputSchema,
  FileEditParameters,
} from '@reflexion-os-studio/contracts'
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { SystemRuntimeClient } from '../../system.js'
import { callSystem } from './shared.js'
import { recordResultRevision, type FileReadState } from './read-state.js'

export function createFileEditTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
  readState: FileReadState,
): ToolDefinition {
  return {
    name: 'file.edit',
    description:
      '原子编辑工作区内单个文本文件。同一函数或代码块的关联修改优先一次 replace_range 完整块替换；独立位置使用 edits 数组，每项必须显式填写 kind（文本替换为 "kind":"replace"），可组合 replace、insert_before、insert_after、replace_range；全部操作基于同一原始快照校验，任一失败或重叠则完全不写入。replace_range 的 startLine/endLine 均为 1 起始且包含首尾，直接使用 file.read 的 L 行号，不要减 1；必须同时提供 expectedText，不能只凭行号修改。推荐工具调用携带 path 和非空 edits 数组，不能仅在正文叙述修改。推荐调用示例：{"path":"file.md","edits":[{"kind":"replace","oldText":"原文","newText":"新文"}]}。旧版顶层 oldText/newText 参数仍兼容，但不可与 edits 混用。匹配文本可直接复制 file.read 返回内容，运行时会安全去除 L<行号>: 前缀。需要用户审批。',
    parameters: FileEditParameters,
    execute: ({ args, signal, grant }) => {
      const parsed = FileEditInputSchema.safeParse(args)
      if (!parsed.success) {
        return Promise.resolve({
          content: `编辑参数无效：${FileEditArgumentGuidance}`,
          isError: true,
          code: 'invalid_request',
        })
      }
      const path = parsed.data.path
      const entry = readState.entry(path)
      if (entry === undefined) {
        return Promise.resolve({
          content: `尚未在本轮读取 ${path}：编辑前必须先用 file.read 读取该文件，并复制目标原文到 oldText 或 expectedText。`,
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
      const input = parsed.data
      if ('edits' in input) params.edits = input.edits
      else {
        params.oldText = input.oldText
        params.newText = input.newText
        if (input.expectedCount !== undefined)
          params.expectedCount = input.expectedCount
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
