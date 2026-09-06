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
import { createLegacyUpdatePlanTool, createManagePlanTool } from './plans.js'
import { createTaskTool } from './task.js'

export type { ToolContext } from './shared.js'

/**
 * 单次 Run 的工具装配：时间/网络/Skill 等纯计算工具始终可用；
 * 文件/Shell 工具走 Rust System Runtime，仅在系统就绪且会话有工作区时注册。
 * allowedTools 白名单过滤内置与 MCP 工具；子 Run 未注入 childRunStarter，
 * 因此 task(委派)工具默认不注册——"child 默认无 task"。
 */
export function createToolRegistry(ctx: ToolContext): ToolRegistry {
  const registry = new ToolRegistry()
  const tools = [...alwaysAvailableTools(ctx), ...mcpTools(ctx)]
  if (
    ctx.system !== null &&
    ctx.system.available &&
    ctx.workspaceRoot !== null
  ) {
    tools.push(...workspaceTools(ctx.system, ctx.workspaceRoot))
  }
  for (const tool of tools) {
    if (ctx.allowedTools != null && !ctx.allowedTools.has(tool.name)) {
      continue
    }
    registry.register(tool)
  }
  return registry
}

function alwaysAvailableTools(ctx: ToolContext): ToolDefinition[] {
  const tools = [
    createCurrentTimeTool(),
    createWebFetchTool(),
    createSkillUseTool(ctx.skills),
    createManagePlanTool(ctx),
    createLegacyUpdatePlanTool(ctx),
  ]
  // 只有注入 childRunStarter 的 Run 才具备委派能力(task 工具)；子 Run 默认无此工具。
  if (ctx.childRunStarter) {
    tools.push(createTaskTool(ctx))
  }
  return tools
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
