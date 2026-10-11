import type { ToolResult } from '@reflexion-os-studio/agent-core'
import type {
  AgentSpawnSpec,
  DelegationResult,
  JsonValue,
} from '@reflexion-os-studio/contracts'
import type { SkillRegistry } from '../../skills/index.js'
import type { McpManager } from '../../mcp/manager.js'
import { SystemRuntimeError, type SystemRuntimeClient } from '../../system.js'
import type { Store } from '../../store/index.js'
import type { RunEventEmitter } from '../../events.js'
import type { InteractionGateway } from '../interactions/index.js'

export interface ToolContext {
  store: Store
  sessionId: string
  messageId: string
  runId: string
  emitter: RunEventEmitter
  interactions: InteractionGateway
  system: SystemRuntimeClient | null
  /** 会话关联项目的 folderPath；独立会话为 null（文件/Shell 工具不注册）。 */
  workspaceRoot: string | null
  projectId: string | null
  /** Skill 注册表：skill.use 工具的数据源。 */
  skills: SkillRegistry
  /** MCP 管理服务：非空时把可用 server 工具注册进 Run(默认 ask 审批)。 */
  mcp: McpManager | null
  /** 工具白名单；设置后仅注册名单中的内置/MCP 工具。 */
  allowedTools?: ReadonlySet<string> | null
  /** 启动一个受限子 Run，并等待其结构化结果。 */
  childRunStarter?: (input: {
    task: string
    agent: AgentSpawnSpec
    signal: AbortSignal
  }) => Promise<DelegationResult>
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
    const message = error instanceof Error ? error.message : String(error)
    const revisionConflict =
      (method === 'file.write' ||
        method === 'file.write_stream' ||
        method === 'file.edit') &&
      (message.includes('file changed since last read') ||
        message.includes('file changed since upload began') ||
        message.includes('requires readToken'))
    return {
      content: revisionConflict
        ? `文件 revision 冲突：${message}。请重新 file.read 获取最新内容，基于新内容重新合并变更后再提交；禁止原样重试。`
        : `工具执行失败：${message}`,
      isError: true,
      code: revisionConflict
        ? 'file_revision_conflict'
        : method === 'file.edit' &&
            (message.includes('expectedText does not match') ||
              message.includes('match appears') ||
              message.includes('found 0') ||
              message.includes('occurrences'))
          ? 'file_edit_match_conflict'
          : error instanceof SystemRuntimeError && error.code
            ? error.code
            : 'tool_error',
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

/** 文本参数允许空串（例如清空文件或删除匹配片段），但仍拒绝非字符串。 */
export function requireText(args: JsonValue, key: string): string {
  const value = argsRecord(args)[key]
  if (typeof value !== 'string') {
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
