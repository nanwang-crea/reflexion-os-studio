import {
  ToolRegistry,
  type ToolDefinition,
  type ToolResult,
} from '@reflexion-os-studio/agent-core'
import type { JsonValue } from '@reflexion-os-studio/contracts'
import type { SystemRuntimeClient } from '../system.js'

export interface ToolContext {
  system: SystemRuntimeClient | null
  /** 会话关联项目的 folderPath；独立会话为 null（文件/Shell 工具不注册）。 */
  workspaceRoot: string | null
}

const SYSTEM_REQUEST_TIMEOUT_MS = 130_000

/**
 * 单次 Run 的工具装配：纯计算工具始终可用；
 * 文件/Shell 工具走 Rust System Runtime，仅在系统就绪且会话有工作区时注册。
 */
export function createToolRegistry(ctx: ToolContext): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(createCurrentTimeTool())
  if (
    ctx.system !== null &&
    ctx.system.available &&
    ctx.workspaceRoot !== null
  ) {
    const workspaceRoot = ctx.workspaceRoot
    const system = ctx.system
    registry.register(createFileReadTool(system, workspaceRoot))
    registry.register(createFileListTool(system, workspaceRoot))
    registry.register(createFileWriteTool(system, workspaceRoot))
    registry.register(createShellExecuteTool(system, workspaceRoot))
  }
  return registry
}

/** 统一的 Rust 调用封装：取消向上抛，失败折叠为错误结果回传模型。 */
async function callSystem(
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

function requireString(args: JsonValue, key: string): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error(`invalid tool arguments: expected object`)
  }
  const value = (args as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing or invalid tool argument: ${key}`)
  }
  return value
}

function createCurrentTimeTool(): ToolDefinition {
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

function createFileReadTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.read',
    description:
      '读取工作区内的 UTF-8 文本文件并返回完整内容。path 为工作区相对路径，不允许绝对路径或 ..。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径，如 src/app.ts' },
      },
      required: ['path'],
    },
    execute: ({ args, signal }) =>
      callSystem(
        system,
        'file.read',
        { workspaceRoot, path: requireString(args, 'path') },
        signal,
      ),
  }
}

function createFileListTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.list',
    description:
      '列出工作区内目录的条目（名称/类型/大小）。path 为工作区相对路径，"." 表示根目录。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对目录路径' },
      },
      required: ['path'],
    },
    execute: ({ args, signal }) =>
      callSystem(
        system,
        'file.list',
        { workspaceRoot, path: requireString(args, 'path') },
        signal,
      ),
  }
}

function createFileWriteTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'file.write',
    description:
      '在工作区内写入/覆盖文本文件（自动创建父目录），返回写入字节数。需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径' },
        content: { type: 'string', description: '完整文件内容（UTF-8 文本）' },
      },
      required: ['path', 'content'],
    },
    execute: ({ args, signal, grant }) =>
      callSystem(
        system,
        'file.write',
        {
          workspaceRoot,
          path: requireString(args, 'path'),
          content: requireString(args, 'content'),
          grant: grant ?? '',
        },
        signal,
      ),
  }
}

function createShellExecuteTool(
  system: SystemRuntimeClient,
  workspaceRoot: string,
): ToolDefinition {
  return {
    name: 'shell.execute',
    description:
      '在工作区内执行 shell 命令（POSIX sh / Windows cmd），返回退出码与输出。cwd 需在工作区内；需要用户审批。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: {
          type: 'string',
          description: '工作区相对的工作目录，缺省为工作区根',
        },
      },
      required: ['command'],
    },
    execute: ({ args, signal, grant }) => {
      const params: Record<string, unknown> = {
        workspaceRoot,
        command: requireString(args, 'command'),
        grant: grant ?? '',
      }
      if (
        typeof args === 'object' &&
        args !== null &&
        !Array.isArray(args) &&
        typeof (args as Record<string, unknown>).cwd === 'string'
      ) {
        params.cwd = (args as Record<string, unknown>).cwd
      }
      return callSystem(system, 'shell.execute', params, signal)
    },
  }
}
