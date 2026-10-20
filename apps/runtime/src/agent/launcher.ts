import { RunFinalizer } from './run/run-finalizer.js'
import { createRunExecutionState } from './run/run-state.js'
import { createRunToolRuntime } from './run/tool-runtime.js'
export { resolveWorkspaceRoot } from './run/tool-runtime.js'
import type { RunPermissions } from './delegation/live-permissions.js'
import { composeSystemPrompt } from './prompts/system-prompt.js'
export { composeSystemPrompt } from './prompts/system-prompt.js'
import type {
  ApprovalOverride,
  Message,
  PermissionPreset,
  ProviderProfile,
  Run,
  Session,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter } from '../events.js'
import { type SkillDefinition, type SkillRegistry } from '../skills/index.js'
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
  resolveInputPreset,
} from './permissions/index.js'
import type { RunRunner } from './run/runner.js'
import type { ToolContext } from './tools/shared.js'
import type { InteractionGateway } from './interactions/index.js'
import type { RootMutationCoordinator } from './delegation/mutations.js'

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
  /** 工具白名单：设置后仅开放这些内置/MCP 工具；缺省不限制。 */
  allowedTools?: ReadonlySet<string> | null
  resolvePermissions?: () => RunPermissions
  /** 子 Agent 独立上下文：仅 system prompt + 显式任务包，不注入历史/记忆。 */
  isolatedContext?: boolean
  /** Root tree identity for reusable rules; never used for once grants/Danger. */
  permissionDomainId?: string
  rootRunId?: string
  mutationCoordinator?: RootMutationCoordinator
  defaultChildTemplateId?: string
  runSettings?: import('@reflexion-os-studio/contracts').AgentSettings
  onBeforeModel?: () => void
  onToolBatch?: (toolNames: string[]) => void
  beforeToolInvoke?: (toolName: string) => void
  onModelResult?: (
    usage: import('@reflexion-os-studio/contracts').Usage,
    estimated?: boolean,
  ) => void
  persistResult?: (content: string) => void
}

/** launch 依赖：跨 Run 共享的服务集合（由 ChatAgent 注入）。 */
export interface LaunchDeps {
  skillTools?: ToolContext['skillTools']
  browser?: ToolContext['browser']
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
  private readonly runPermissionPresets = new Map<
    string,
    () => PermissionPreset
  >()

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
    return this.runPermissionPresets.get(runId)?.() ?? DEFAULT_PRESET
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
    const { run, profile, apiKey, model, sampling, assistantMessage, emitter } =
      input
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
    this.runPermissionPresets.set(
      run.id,
      () => input.resolvePermissions?.().permissionPreset ?? preset,
    )
    let failureDelivered = false
    const onFailure = (error: Error): void => {
      if (failureDelivered) return
      failureDelivered = true
      try {
        input.onFailure?.(error)
      } catch {
        process.stderr.write('[runtime] Run failure callback failed\n')
      }
    }
    let enteredRunner = false
    void (async () => {
      const settings = input.runSettings ?? this.deps.store.agentSettings.get()
      const provider: ProviderRuntimeConfig = {
        baseUrl: profile.baseUrl,
        apiKey,
        model,
        apiFormat: profile.apiFormat,
        headers: profile.headers,
        ...sampling,
        ...(profile.reasoningEffort != null
          ? { reasoningEffort: profile.reasoningEffort }
          : {}),
        ...(profile.contextWindow !== null
          ? { contextWindow: profile.contextWindow }
          : {}),
        ...(profile.contextBudget !== null
          ? { contextBudget: profile.contextBudget }
          : {}),
        ...(settings.requestBackoffInitialSec != null
          ? { retryBackoffInitialMs: settings.requestBackoffInitialSec * 1000 }
          : {}),
        ...(settings.requestBackoffMaxSec != null
          ? { retryBackoffMaxMs: settings.requestBackoffMaxSec * 1000 }
          : {}),
        ...(settings.requestRetries !== null
          ? { maxRetries: settings.requestRetries }
          : {}),
        ...(settings.requestTimeoutSec !== null
          ? { timeoutMs: settings.requestTimeoutSec * 1000 }
          : {}),
      }
      const { registry, gate, workspaceRoot } = createRunToolRuntime(
        this.deps,
        input,
        preset,
      )
      const sessionId = run.sessionId
      enteredRunner = true
      await this.deps.runner.execute({
        run,
        provider,
        buildHistory: (signal) => {
          const systemPrompt =
            input.systemPrompt ??
            composeSystemPrompt(
              this.deps.skills,
              input.skill,
              input.childRunStarter
                ? this.deps.store.agents.list(input.session.projectId)
                : undefined,
              input.session.projectId,
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
                registry.specs(),
              )
        },
        registry,
        workspaceRoot,
        gate,
        approvals: this.deps.approvals,
        sandboxProvider: this.deps.system?.sandboxName ?? null,
        system: this.deps.system,
        permissionDomainId: input.permissionDomainId ?? run.sessionId,
        rootRunId: input.rootRunId ?? run.id,
        mutationCoordinator: input.mutationCoordinator,
        controller,
        emitter,
        firstAssistantMessage: assistantMessage,
        settings,
        onBeforeModel: input.onBeforeModel,
        onToolBatch: input.onToolBatch,
        beforeToolInvoke: input.beforeToolInvoke,
        onModelResult: input.onModelResult,
        persistResult: input.persistResult,
        onResult: input.onResult,
        onFailure,
        onCancel: input.onCancel,
        childTokenBudget: input.childTokenBudget,
      })
    })()
      // Finalization can itself fail; never leave a delegating parent waiting.
      .catch((error: unknown) => {
        if (!enteredRunner) {
          try {
            new RunFinalizer(this.deps.store).finalize(
              { ...input, onFailure, state: createRunExecutionState() },
              {
                status: 'failed',
                errorCode: 'run_setup_failed',
                errorMessage:
                  error instanceof Error ? error.message : 'Run setup failed',
                pendingMessage: null,
              },
            )
            return
          } catch {
            process.stderr.write('[runtime] Run setup finalization failed\n')
          }
        }
        process.stderr.write(
          `[runtime] Run execution escaped (run:${run.id})\n`,
        )
        try {
          onFailure(new Error('Run 执行或终态收尾异常，请检查运行日志'))
        } catch {
          process.stderr.write(
            `[runtime] Run failure callback failed (run:${run.id})\n`,
          )
        }
      })
      .finally(() => {
        try {
          this.deps.browser?.finishRun(run.id, controller.signal.aborted)
        } catch {
          process.stderr.write('[runtime] Browser Run cleanup failed\n')
        }
        parentSignal?.removeEventListener('abort', abortChild)
        this.streams.delete(run.id)
        this.runDepth.delete(run.id)
        this.runPermissionPresets.delete(run.id)
        // Run 结束(完成/失败/取消):自动出队发送排队中的下一条。
        try {
          this.deps.skillTools?.releaseRun(run.id)
        } catch {
          process.stderr.write('[runtime] Skill resource cleanup failed\n')
        }
        try {
          this.hooks.onRunSettled(run.sessionId)
        } catch {
          process.stderr.write('[runtime] Run settled hook failed\n')
        }
      })
  }
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
