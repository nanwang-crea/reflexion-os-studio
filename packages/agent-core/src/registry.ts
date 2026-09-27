import type { JsonValue, ToolSpec } from '@reflexion-os-studio/contracts'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
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
 * 参数在权限判断与执行前统一按 ToolDefinition.parameters 校验；工具内部仍可
 * 承担跨字段状态约束，但不再各自重复基础形状校验。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly validators = new Map<string, ValidateFunction>()
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false })

  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`)
    }
    this.validators.set(
      definition.name,
      this.ajv.compile(definition.parameters as object),
    )
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

  validateRequest(
    request: ToolCallRequest,
  ):
    | { ok: true; tool: ToolDefinition; args: JsonValue }
    | { ok: false; result: ToolResult } {
    const tool = this.tools.get(request.name)
    if (!tool) {
      return {
        ok: false,
        result: {
          content: `unknown tool: ${request.name}`,
          isError: true,
          code: 'unsupported',
        },
      }
    }
    let args: JsonValue
    try {
      args = parseJsonArgs(request.arguments)
    } catch {
      return {
        ok: false,
        result: {
          content: `invalid tool arguments (not valid JSON): ${truncate(request.arguments)}`,
          isError: true,
          code: 'invalid_request',
        },
      }
    }
    const validator = this.validators.get(request.name)!
    if (!validator(args)) {
      const issues = (validator.errors ?? []).map((error) => {
        const path = error.instancePath
          ? `$${error.instancePath.replaceAll('/', '.')}`
          : '$'
        const message = (error.message ?? 'is invalid').replace(
          /^must be (string|number|integer|object|array|boolean|null)$/,
          'must be a $1',
        )
        return `${path} ${message}`
      })
      return {
        ok: false,
        result: {
          content: `invalid tool arguments: ${issues.slice(0, 4).join('; ')}`,
          isError: true,
          code: 'invalid_request',
        },
      }
    }
    return { ok: true, tool, args }
  }

  /** 解析并执行一次工具调用；永不抛出，错误折叠为 isError 结果。 */
  async call(
    request: ToolCallRequest,
    signal: AbortSignal,
    grant?: string,
  ): Promise<ToolResult> {
    const validated = this.validateRequest(request)
    if (!validated.ok) return validated.result
    const executionArgs: ToolExecutionArgs = {
      args: validated.args,
      toolCallId: request.id,
      signal,
      grant,
    }
    try {
      return await validated.tool.execute(executionArgs)
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
