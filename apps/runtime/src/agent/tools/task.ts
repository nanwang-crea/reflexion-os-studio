import type { ToolDefinition } from '@reflexion-os-studio/agent-core'
import type { JsonValue } from '@reflexion-os-studio/contracts'
import type { ToolContext } from './shared.js'

/** Minimal safe delegation tool: unavailable unless the host injects a starter. */
export function createTaskTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'task',
    description:
      '启动一个独立子 Run 完成指定子任务，并返回其最终结果。用户明确要求子 Agent 时使用；复杂任务中的独立调研、实现或验证工作优先委派。task 应包含目标、范围、上下文和预期交付。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要委派的子任务' },
        agentId: {
          type: 'string',
          description: '兼容字段：可选模板 ID。新调用优先使用 templateId。',
        },
        templateId: { type: 'string', description: '可选模板 ID' },
        name: { type: 'string', description: '动态 Agent 名称' },
        role: { type: 'string', description: '动态 Agent 职责' },
        instructions: { type: 'string', description: '本次实例补充指令' },
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
      const optional = (key: string): string | undefined =>
        typeof input[key] === 'string' && input[key].trim()
          ? input[key].trim()
          : undefined
      try {
        const result = await ctx.childRunStarter({
          task: input.task,
          agent: {
            templateId: optional('templateId') ?? optional('agentId'),
            name: optional('name'),
            role: optional('role'),
            instructions: optional('instructions'),
          },
          signal,
        })
        return {
          content: result.summary,
          data: result,
          resourceLinks: result.resourceLinks,
          changedFiles: result.changedFiles,
          isError: false,
        }
      } catch (error) {
        // 子 Run 限额/超时等用 ChildLimitError 携带稳定 code，透传而不是折叠为 tool_error。
        const code =
          error instanceof Error &&
          typeof (error as unknown as { code?: unknown }).code === 'string'
            ? (error as unknown as { code: string }).code
            : 'tool_error'
        return {
          content: `子 Run 执行失败：${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          code,
        }
      }
    },
  }
}
