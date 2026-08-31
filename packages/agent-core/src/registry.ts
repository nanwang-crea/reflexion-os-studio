import type { JsonValue, ToolSpec } from '@reflexion-os-studio/contracts'
import type {
  ToolCallRequest,
  ToolDefinition,
  ToolExecutionArgs,
  ToolResult,
} from './types.js'

/**
 * 工具注册表：统一的工具声明与执行入口。
 * 未知工具、非 JSON 参数都以 isError 结果回传模型（可自纠），
 * 而不是打断整个 Run；工具内部异常同样折叠为错误结果。
 * 参数只做 JSON 解析（不校验 schema），参数形状的合法性由各工具
 * execute 自行负责——parameters 仅作模型声明，不在此强制约束。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`)
    }
    this.tools.set(definition.name, definition)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** 解析并执行一次工具调用；永不抛出，错误折叠为 isError 结果。 */
  async call(
    request: ToolCallRequest,
    signal: AbortSignal,
    grant?: string,
  ): Promise<ToolResult> {
    const tool = this.tools.get(request.name)
    if (!tool) {
      return {
        content: `unknown tool: ${request.name}`,
        isError: true,
        code: 'unsupported',
      }
    }
    let args: JsonValue
    try {
      args = parseJsonArgs(request.arguments)
    } catch {
      return {
        content: `invalid tool arguments (not valid JSON): ${truncate(request.arguments)}`,
        isError: true,
        code: 'invalid_request',
      }
    }
    const executionArgs: ToolExecutionArgs = { args, signal, grant }
    try {
      return await tool.execute(executionArgs)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      return {
        content: `tool failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        code: 'tool_error',
      }
    }
  }
}

function parseJsonArgs(arguments_: string): JsonValue {
  if (arguments_.trim() === '') return {}
  const parsed: unknown = JSON.parse(arguments_)
  return parsed as JsonValue
}

function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
