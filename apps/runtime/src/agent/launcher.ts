import type {
  AgentDefinition,
  ApprovalOverride,
  Message,
  PermissionPreset,
  ProviderProfile,
  Run,
  Session,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter } from '../events.js'
import {
  activeSkillPromptSection,
  skillsPromptSection,
  type SkillDefinition,
  type SkillRegistry,
} from '../skills/index.js'
import type { Store } from '../store/index.js'
import type { SystemRuntimeClient } from '../system.js'
import type { McpManager } from '../mcp/manager.js'
import {
  ContextBuilder,
  type ProviderRuntimeConfig,
} from './context/context.js'
import {
  ApprovalGateway,
  DangerLeaseService,
  DEFAULT_PRESET,
  PermissionGate,
  resolveInputPreset,
} from './permissions/index.js'
import {
  PRIMARY_AGENT_SYSTEM_PROMPT,
  availableAgentsPromptSection,
} from './prompts/index.js'
import type { RunRunner } from './run/runner.js'
import { createToolRegistry } from './tools/index.js'
import type { ToolContext } from './tools/shared.js'
import type { InteractionGateway } from './interactions/index.js'

/** launch 选项：单次 Run 的装配参数（Provider/工具/闸门/回调）。 */
export interface LaunchOptions {
  run: Run
  session: Session
  profile: ProviderProfile
  apiKey: string
  model: string
  sampling: { temperature?: number; maxTokens?: number }
  /** 本次 Run 的权限预设快照（message.send 解析结果；缺省 workspace-read）。 */
  permissionPreset?: PermissionPreset
  /** 本次 Run 的高级审批覆盖项（会话级；Runtime 启动 Run 时读取）。 */
  approvalOverride?: ApprovalOverride
  skill: SkillDefinition | null
  systemPrompt?: string
  assistantMessage: Message
  emitter: RunEventEmitter
  childRunStarter?: ToolContext['childRunStarter']
  onResult?: (content: string) => void
  onFailure?: (error: Error) => void
  onCancel?: () => void
  parentSignal?: AbortSignal
  /** 委派深度：顶层为 0，每下一层 +1，用于 maxDepth 强制。 */
  depth?: number
  /** 子 Run 累计输出 token 预算；超出以 child_token_budget 中止。 */
  childTokenBudget?: number
  /** 工具白名单：设置后仅注册这些内置/MCP 工具；缺省不限制。 */
  allowedTools?: ReadonlySet<string> | null
  /** 子 Agent 独立上下文：仅 system prompt + 显式任务包，不注入历史/记忆。 */
  isolatedContext?: boolean
}

/** launch 依赖：跨 Run 共享的服务集合（由 ChatAgent 注入）。 */
export interface LaunchDeps {
  store: Store
  system: SystemRuntimeClient | null
  mcp: McpManager | null
  runner: RunRunner
  contextBuilder: ContextBuilder
  approvals: ApprovalGateway
  interactions: InteractionGateway
  danger: DangerLeaseService
  skills: SkillRegistry
}

export interface LaunchHooks {
  /** Run 结束(完成/失败/取消)后回调：门面用它自动出队发送排队中的下一条。 */
  onRunSettled: (sessionId: string) => void
}

/**
 * Run 装配与生命周期登记：持有 Run 级取消句柄/委派深度/权限预设，
 * 按 Run 组装工具注册表与权限闸门后交 RunRunner 后台执行。
 */
export class RunLauncher {
  private readonly streams = new Map<string, { controller: AbortController }>()
  private readonly runDepth = new Map<string, number>()
  private readonly runPermissionPresets = new Map<string, PermissionPreset>()

  constructor(
    private readonly deps: LaunchDeps,
    private readonly hooks: LaunchHooks,
  ) {}

  /** 委派边界读取：父 Run 的深度（顶层 0）。 */
  depthOf(runId: string): number {
    return this.runDepth.get(runId) ?? 0
  }

  /** 委派边界读取：父 Run 的权限预设（缺省最窄日常档）。 */
  permissionPresetOf(runId: string): PermissionPreset {
    return this.runPermissionPresets.get(runId) ?? DEFAULT_PRESET
  }

  /** 只有确实在运行中（含等待审批）的 Run 才受理；终态或不存在返回 false。 */
  cancel(runId: string): boolean {
    const stream = this.streams.get(runId)
    if (!stream) return false
    stream.controller.abort()
    return true
  }

  /** 后台启动执行：按 Run 装配工具/闸门，历史构建与工具循环共享失败/取消路径。 */
  launch(input: LaunchOptions): void {
    const {
      run,
      session,
      profile,
      apiKey,
      model,
      sampling,
      assistantMessage,
      emitter,
    } = input
    const controller = new AbortController()
    const parentSignal = input.parentSignal
    const abortChild = () => controller.abort(parentSignal?.reason)
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason)
      else parentSignal.addEventListener('abort', abortChild, { once: true })
    }
    this.streams.set(run.id, { controller })
    this.runDepth.set(run.id, input.depth ?? 0)
    const preset = resolveInputPreset({
      permissionPreset: input.permissionPreset,
    })
    this.runPermissionPresets.set(run.id, preset)
    const settings = this.deps.store.agentSettings.get()
    const provider: ProviderRuntimeConfig = {
      baseUrl: profile.baseUrl,
      apiKey,
      model,
      apiFormat: profile.apiFormat,
      ...sampling,
      ...(profile.contextWindow !== null
        ? { contextWindow: profile.contextWindow }
        : {}),
      ...(profile.contextBudget !== null
        ? { contextBudget: profile.contextBudget }
        : {}),
      ...(settings.requestRetries !== null
        ? { maxRetries: settings.requestRetries }
        : {}),
      ...(settings.requestTimeoutSec !== null
        ? { timeoutMs: settings.requestTimeoutSec * 1000 }
        : {}),
    }
    const sessionId = run.sessionId
    const workspaceRoot = resolveWorkspaceRoot(this.deps.store, session)
    const registry = createToolRegistry({
      store: this.deps.store,
      sessionId,
      messageId: assistantMessage.id,
      runId: run.id,
      emitter,
      interactions: this.deps.interactions,
      system: this.deps.system,
      workspaceRoot,
      skills: this.deps.skills,
      mcp: this.deps.mcp,
      childRunStarter: input.childRunStarter,
      allowedTools: input.allowedTools,
    })
    const gate = new PermissionGate({
      preset,
      hasWorkspace: workspaceRoot !== null,
      approvalOverride:
        input.approvalOverride ??
        this.deps.approvals.approvalOverrideFor(sessionId),
      dangerActive: () => this.deps.danger.isActive(sessionId),
      executionMode: () =>
        this.deps.store.sessions.get(sessionId)?.executionMode ?? 'execute',
    })
    void this.deps.runner
      .execute({
        run,
        provider,
        buildHistory: (signal) => {
          const systemPrompt =
            input.systemPrompt ??
            composeSystemPrompt(
              this.deps.skills,
              input.skill,
              input.childRunStarter ? this.deps.store.agents.list() : undefined,
            )
          return input.isolatedContext
            ? Promise.resolve(
                this.deps.contextBuilder.buildIsolated(sessionId, systemPrompt),
              )
            : this.deps.contextBuilder.build(
                sessionId,
                systemPrompt,
                provider,
                signal,
              )
        },
        registry,
        workspaceRoot,
        gate,
        approvals: this.deps.approvals,
        sandboxProvider: this.deps.system?.sandboxName ?? null,
        controller,
        emitter,
        firstAssistantMessage: assistantMessage,
        settings,
        onResult: input.onResult,
        onFailure: input.onFailure,
        onCancel: input.onCancel,
        childTokenBudget: input.childTokenBudget,
      })
      // runner 自吞全部执行期异常；此处仅保证取消句柄必然清理。
      .catch(() => {})
      .finally(() => {
        parentSignal?.removeEventListener('abort', abortChild)
        this.streams.delete(run.id)
        this.runDepth.delete(run.id)
        this.runPermissionPresets.delete(run.id)
        // Run 结束(完成/失败/取消):自动出队发送排队中的下一条。
        this.hooks.onRunSettled(run.sessionId)
      })
  }
}

/** system prompt = 主 prompt + 可用 Skills 清单 +（可选）本次激活技能的完整说明。 */
export function composeSystemPrompt(
  skills: SkillRegistry,
  skill: SkillDefinition | null,
  agents: readonly AgentDefinition[] = [],
): string {
  const base = `${PRIMARY_AGENT_SYSTEM_PROMPT}${skillsPromptSection(skills.list())}${availableAgentsPromptSection(agents)}`
  return skill === null ? base : `${base}${activeSkillPromptSection(skill)}`
}

/** 会话的工作区根：项目 folderPath；独立会话/空路径返回 null（工具被拒绝）。 */
export function resolveWorkspaceRoot(
  store: Store,
  session: Session,
): string | null {
  if (session.projectId === null) return null
  const project = store.projects.get(session.projectId)
  if (!project || project.folderPath === '') return null
  return project.folderPath
}

/** 门面预建的首轮 assistant 消息（保持 message.send 返回 messageId 的契约）。 */
export function createPendingAssistantMessage(
  store: Store,
  sessionId: string,
  run: Run,
): Message {
  return store.messages.create({
    sessionId,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
}
