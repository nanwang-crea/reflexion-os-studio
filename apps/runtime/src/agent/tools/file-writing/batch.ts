import { FileEditBatchParameters } from '@reflexion-os-studio/contracts'
import type { ToolDefinition } from '@reflexion-os-studio/agent-core'

/** This orchestration tool must be expanded by the admitted Runtime executor. */
export function createFileEditBatchTool(): ToolDefinition {
  return {
    name: 'file.edit_batch',
    description:
      '一次提交多个已读取文件的独立编辑，最多16个不同文件。files 每项与 file.edit 参数相同。逐文件审批和 revision 校验，每个文件内 edits 原子执行；跨文件不保证全部成功。结果逐项报告成功、失败、取消或未执行，禁止重放成功项；有前后依赖的修改不要放在同批。',
    parameters: FileEditBatchParameters,
    execution: { effect: 'state', idempotent: false },
    execute: () => ({
      content: 'file.edit_batch requires Runtime orchestration',
      isError: true,
      code: 'unsupported',
    }),
  }
}
