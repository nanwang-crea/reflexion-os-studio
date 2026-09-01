import {
  ToolRegistry,
  type ToolDefinition,
} from '@reflexion-os-studio/agent-core'
import {
  createFileEditTool,
  createFileDeleteTool,
  createFileMkdirTool,
  createFileMoveTool,
  createFileWriteTool,
} from './files-mutate.js'
import {
  createFileGlobTool,
  createFileGrepTool,
  createFileListTool,
  createFileReadTool,
} from './files-query.js'
import { createShellExecuteTool } from './shell.js'
import { createSkillUseTool } from './skills.js'
import type { ToolContext } from './shared.js'
import { createCurrentTimeTool } from './time.js'
import { createWebFetchTool } from './web.js'
import { createMcpTool } from './mcp.js'
import { createUpdatePlanTool } from './plans.js'

export type { ToolContext } from './shared.js'

/**
 * 单次 Run 的工具装配：时间/网络/Skill 等纯计算工具始终可用；
 * 文件/Shell 工具走 Rust System Runtime，仅在系统就绪且会话有工作区时注册。
 */
export function createToolRegistry(ctx: ToolContext): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of alwaysAvailableTools(ctx)) {
    registry.register(tool)
  }
  for (const tool of mcpTools(ctx)) {
    registry.register(tool)
  }
  if (
    ctx.system !== null &&
    ctx.system.available &&
    ctx.workspaceRoot !== null
  ) {
    const workspaceRoot = ctx.workspaceRoot
    const system = ctx.system
    for (const tool of workspaceTools(system, workspaceRoot)) {
      registry.register(tool)
    }
  }
  return registry
}

function alwaysAvailableTools(ctx: ToolContext): ToolDefinition[] {
  return [
    createCurrentTimeTool(),
    createWebFetchTool(),
    createSkillUseTool(ctx.skills),
    createUpdatePlanTool(ctx),
  ]
}

function mcpTools(ctx: ToolContext): ToolDefinition[] {
  const manager = ctx.mcp
  if (manager === null) return []
  return manager
    .allTools()
    .map((tool) =>
      createMcpTool(manager, tool.serverId, tool.toolName, tool.spec),
    )
}

function workspaceTools(
  system: NonNullable<ToolContext['system']>,
  workspaceRoot: string,
): ToolDefinition[] {
  return [
    createFileReadTool(system, workspaceRoot),
    createFileListTool(system, workspaceRoot),
    createFileGlobTool(system, workspaceRoot),
    createFileGrepTool(system, workspaceRoot),
    createFileWriteTool(system, workspaceRoot),
    createFileEditTool(system, workspaceRoot),
    createFileDeleteTool(system, workspaceRoot),
    createFileMoveTool(system, workspaceRoot),
    createFileMkdirTool(system, workspaceRoot),
    createShellExecuteTool(system, workspaceRoot),
  ]
}
