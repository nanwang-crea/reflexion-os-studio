import type { ToolResult } from '@reflexion-os-studio/agent-core'
import type { JsonValue } from '@reflexion-os-studio/contracts'
import type { SkillRegistry } from '../../skills/index.js'
import type { McpManager } from '../../mcp/manager.js'
import type { SystemRuntimeClient } from '../../system.js'

export interface ToolContext {
  system: SystemRuntimeClient | null
  /** 会话关联项目的 folderPath；独立会话为 null（文件/Shell 工具不注册）。 */
  workspaceRoot: string | null
  /** Skill 注册表：skill.use 工具的数据源。 */
  skills: SkillRegistry
  /** MCP 管理服务：非空时把可用 server 工具注册进 Run(默认 ask 审批)。 */
  mcp: McpManager | null
}

const SYSTEM_REQUEST_TIMEOUT_MS = 130_000

/** 统一的 Rust 调用封装：取消向上抛，失败折叠为错误结果回传模型。 */
export async function callSystem(
  system: SystemRuntimeClient,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolResult> {
  try {
    const result = await system.request(method, params, {
      signal,
      timeoutMs: SYSTEM_REQUEST_TIMEOUT_MS,
    })
    return { content: JSON.stringify(result), isError: false }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return {
      content: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      code: 'tool_error',
    }
  }
}

export function argsRecord(args: JsonValue): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('invalid tool arguments: expected object')
  }
  return args as Record<string, unknown>
}

export function requireString(args: JsonValue, key: string): string {
  const value = argsRecord(args)[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing or invalid tool argument: ${key}`)
  }
  return value
}

export function optionalString(
  args: JsonValue,
  key: string,
): string | undefined {
  const value = argsRecord(args)[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value
}

export function optionalNumber(
  args: JsonValue,
  key: string,
): number | undefined {
  const value = argsRecord(args)[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}
