import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { JsonValue } from '@reflexion-os-studio/contracts'
import type { ToolContext } from './shared.js'

/** Minimal safe delegation tool: unavailable unless the host injects a starter. */
export function createTaskTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'task',
    description:
      '启动一个独立子 Run 完成指定子任务，并返回其最终结果。仅用于确实需要委派的工作。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要委派的子任务' },
        agentId: { type: 'string', description: '可选的子 Agent ID' },
      },
      required: ['task'],
    },
    execute: async ({
      args,
      signal,
    }: {
      args: JsonValue
      signal: AbortSignal
    }) => {
      if (!ctx.childRunStarter) {
        return {
          content: 'task 当前不可用：运行时未配置子 Run 启动器',
          isError: true,
          code: 'unsupported',
        }
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new Error('arguments must be an object')
      }
      const input = args as Record<string, unknown>
      if (typeof input.task !== 'string' || !input.task.trim()) {
        throw new Error('task is required')
      }
      if (typeof input.agentId !== 'string' || !input.agentId.trim()) {
        throw new Error('agentId is required')
      }
      const agentId = input.agentId.trim()
      try {
        const result = await ctx.childRunStarter({
          task: input.task,
          agentId,
          parentRunId: ctx.runId,
          signal,
        })
        return { content: result, isError: false }
      } catch (error) {
        return {
          content: `子 Run 执行失败：${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          code: 'tool_error',
        }
      }
    },
  }
}
