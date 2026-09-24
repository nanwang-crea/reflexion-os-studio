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
 * 参数在权限判断与执行前统一按 ToolDefinition.parameters 校验；工具内部仍可
 * 承担跨字段状态约束，但不再各自重复基础形状校验。
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
    const issues = validateSchema(tool.parameters, args, '$')
    if (issues.length > 0) {
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

function validateSchema(
  schema: JsonValue,
  value: JsonValue,
  path: string,
): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
    return []
  const spec = schema as Record<string, JsonValue>
  if (
    Array.isArray(spec.enum) &&
    !spec.enum.some((item) => Object.is(item, value))
  ) {
    return [`${path} must be one of ${spec.enum.map(String).join(', ')}`]
  }
  const type = typeof spec.type === 'string' ? spec.type : null
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return [`${path} must be an object`]
    }
    const record = value as Record<string, JsonValue>
    const properties =
      typeof spec.properties === 'object' &&
      spec.properties !== null &&
      !Array.isArray(spec.properties)
        ? (spec.properties as Record<string, JsonValue>)
        : {}
    const issues: string[] = []
    const required = Array.isArray(spec.required) ? spec.required : []
    for (const key of required) {
      if (typeof key === 'string' && !(key in record))
        issues.push(`${path}.${key} is required`)
    }
    if (spec.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) issues.push(`${path}.${key} is not allowed`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (properties[key] !== undefined) {
        issues.push(...validateSchema(properties[key], child, `${path}.${key}`))
      }
    }
    return issues
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    const issues: string[] = []
    if (typeof spec.minItems === 'number' && value.length < spec.minItems) {
      issues.push(`${path} must contain at least ${spec.minItems} item(s)`)
    }
    if (spec.items !== undefined) {
      value.forEach((item, index) => {
        issues.push(...validateSchema(spec.items!, item, `${path}[${index}]`))
      })
    }
    return issues
  }
  if (type === 'string' && typeof value !== 'string')
    return [`${path} must be a string`]
  if (type === 'number' && typeof value !== 'number')
    return [`${path} must be a number`]
  if (
    type === 'integer' &&
    (typeof value !== 'number' || !Number.isInteger(value))
  ) {
    return [`${path} must be an integer`]
  }
  if (type === 'boolean' && typeof value !== 'boolean')
    return [`${path} must be a boolean`]
  if (type === 'null' && value !== null) return [`${path} must be null`]
  if (
    typeof value === 'string' &&
    typeof spec.minLength === 'number' &&
    value.length < spec.minLength
  ) {
    return [`${path} must not be empty`]
  }
  return []
}

function parseJsonArgs(arguments_: string): JsonValue {
  if (arguments_.trim() === '') return {}
  const parsed: unknown = JSON.parse(arguments_)
  return parsed as JsonValue
}

function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
