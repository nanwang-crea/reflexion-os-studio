import {
  ToolRegistry,
  type ToolDefinition,
} from '@reflexion-os-studio/agent-core'
import {
  READ_POLICY,
  STATE_POLICY,
  SHELL_POLICY,
  WEB_READ_POLICY,
  WRITE_POLICY,
} from '../run/tool-policies.js'
import {
  createFileEditTool,
  createFileDeleteTool,
  createFileMkdirTool,
  createFileMoveTool,
  createFileWriteTool,
  createFileWriteStreamTool,
} from './files-mutate.js'
import {
  createFileGlobTool,
  createFileGrepTool,
  createFileListTool,
  createFileReadTool,
} from './files-query.js'
import { createShellExecuteTool } from './shell.js'
import { createShellOutputReadTool, ShellOutputStore } from './shell-output.js'
import { createSkillUseTool } from './skills.js'
import { createMemoryRememberTool } from './instructions.js'
import type { ToolContext } from './shared.js'
import { createCurrentTimeTool } from './time.js'
import { createWebFetchTool } from './web.js'
import { createMcpTool } from './mcp.js'
import { createLegacyUpdatePlanTool, createManagePlanTool } from './plans.js'
import { createTaskTool } from './task.js'
import { FileReadState } from './read-state.js'
import { createAskUserTool } from './ask-user.js'
import { createEnterPlanModeTool, createExitPlanModeTool } from './plan-mode.js'

export type { ToolContext } from './shared.js'

/**
 * 单次 Run 的工具装配：时间/网络/Skill 等纯计算工具始终可用；
 * 文件/Shell 工具走 Rust System Runtime，仅在系统就绪且会话有工作区时注册。
 * allowedTools 白名单过滤内置与 MCP 工具；只有深度预算内的 Run 注入
 * childRunStarter 并注册 task，达到上限后自然失去继续委派能力。
 */
export function createToolRegistry(ctx: ToolContext): ToolRegistry {
  const registry = new ToolRegistry()
  // 先读后写凭据状态：file.read 记录，file.write/edit 消费，随 Run 生命周期。
  const turnExecutions = ctx.store.turnExecutions
  const latest = turnExecutions?.latestForRun(ctx.runId)
  const runtimeState = latest?.runtimeState
  const initial =
    typeof runtimeState === 'object' &&
    runtimeState !== null &&
    !Array.isArray(runtimeState) &&
    typeof runtimeState.fileReads === 'object' &&
    runtimeState.fileReads !== null &&
    !Array.isArray(runtimeState.fileReads)
      ? (runtimeState.fileReads as unknown as Record<
          string,
          import('./read-state.js').FileReadRecord
        >)
      : undefined
  const readState = new FileReadState(initial, (fileReads) => {
    if (!turnExecutions) return
    const turn = turnExecutions.latestForRun(ctx.runId)
    if (turn && turn.completedAt === null) {
      turnExecutions.transition(turn.id, turn.phase, {
        runtimeState: JSON.parse(JSON.stringify({ fileReads })),
      })
    }
  })
  const shellOutputStore = new ShellOutputStore()
  const tools = [
    ...alwaysAvailableTools(ctx),
    ...mcpTools(ctx),
    ...(ctx.system !== null &&
    ctx.system.available &&
    ctx.workspaceRoot !== null
      ? workspaceTools(
          ctx.system,
          ctx.workspaceRoot,
          readState,
          shellOutputStore,
        )
      : []),
  ]
  for (let tool of tools) {
    if (
      ctx.allowedTools != null &&
      !ctx.allowedTools.has(tool.name) &&
      !(
        tool.name === 'shell.output.read' &&
        ctx.allowedTools.has('shell.execute')
      ) &&
      !(tool.name === 'file.write_stream' && ctx.allowedTools.has('file.write'))
    ) {
      continue
    }
    tool = withExecutionPolicy(tool)
    registry.register(tool)
  }
  return registry
}

/** 按工具名附加副作用调度元数据（W3）；MCP 工具保守串行。 */
function withExecutionPolicy(tool: ToolDefinition): ToolDefinition {
  if (tool.execution !== undefined) return tool
  if (tool.name.includes('/')) {
    // MCP 工具：无 readOnlyHint 信息前保守按 state 串行（ask 审批不受影响）。
    return { ...tool, execution: STATE_POLICY }
  }
  const policy = BUILTIN_POLICIES[tool.name]
  return policy === undefined ? tool : { ...tool, execution: policy }
}

const BUILTIN_POLICIES: Record<string, ToolDefinition['execution']> = {
  get_current_time: { effect: 'pure' },
  'web.fetch': WEB_READ_POLICY,
  'skill.use': { effect: 'read', resourceKeys: () => [] },
  'memory.remember': STATE_POLICY,
  ask_user: STATE_POLICY,
  enter_plan_mode: STATE_POLICY,
  exit_plan_mode: STATE_POLICY,
  manage_plan: STATE_POLICY,
  update_plan: STATE_POLICY,
  // 同一模型轮声明的多个独立委派可并行；ChildRunStarter 负责并发上限。
  task: { effect: 'read', resourceKeys: () => [] },
  'file.read': READ_POLICY(),
  'file.list': READ_POLICY(),
  'file.glob': READ_POLICY(false),
  'file.grep': READ_POLICY(false),
  'file.write': WRITE_POLICY,
  'file.write_stream': WRITE_POLICY,
  'file.edit': WRITE_POLICY,
  'file.delete': WRITE_POLICY,
  'file.move': WRITE_POLICY,
  'file.mkdir': WRITE_POLICY,
  'shell.execute': SHELL_POLICY,
  'shell.output.read': READ_POLICY(false),
}

function alwaysAvailableTools(ctx: ToolContext): ToolDefinition[] {
  const tools = [
    createCurrentTimeTool(),
    createWebFetchTool(),
    createSkillUseTool(ctx.skills, ctx.projectId),
    createMemoryRememberTool(ctx),
    createAskUserTool(ctx),
    createEnterPlanModeTool(ctx),
    createExitPlanModeTool(ctx),
    createManagePlanTool(ctx),
    createLegacyUpdatePlanTool(ctx),
  ]
  // 只有注入 childRunStarter 的 Run 才具备委派能力；深度上限由装配层截断。
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
  readState: FileReadState,
  shellOutputStore: ShellOutputStore,
): ToolDefinition[] {
  return [
    createFileReadTool(system, workspaceRoot, readState),
    createFileListTool(system, workspaceRoot),
    createFileGlobTool(system, workspaceRoot),
    createFileGrepTool(system, workspaceRoot),
    createFileWriteTool(system, workspaceRoot, readState),
    createFileWriteStreamTool(system, workspaceRoot, readState),
    createFileEditTool(system, workspaceRoot, readState),
    createFileDeleteTool(system, workspaceRoot, readState),
    createFileMoveTool(system, workspaceRoot, readState),
    createFileMkdirTool(system, workspaceRoot),
    createShellExecuteTool(system, workspaceRoot, shellOutputStore),
    createShellOutputReadTool(shellOutputStore),
  ]
}
