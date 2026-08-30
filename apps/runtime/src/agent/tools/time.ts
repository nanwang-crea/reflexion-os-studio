import type { ToolDefinition } from '@reflexion-os-studio/agent-core'

/** 纯计算工具：始终可用，不依赖 Rust System Runtime。 */
export function createCurrentTimeTool(): ToolDefinition {
  return {
    name: 'get_current_time',
    description: '获取当前本地日期时间。当任务需要知道现在几点/日期时调用。',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      const now = new Date()
      return {
        content: JSON.stringify({
          local: now.toString(),
          iso: now.toISOString(),
        }),
        isError: false,
      }
    },
  }
}
