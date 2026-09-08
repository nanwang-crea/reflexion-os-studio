import { randomUUID } from 'node:crypto'
import type {
  AgentSettings,
  ChatCommand,
  Message,
  ProviderProfile,
  Run,
  Session,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../events.js'
import { loadSecret } from '../secrets.js'
import {
  activeSkillPromptSection,
  builtinSkills,
  resolveInvocation,
  skillsPromptSection,
} from '../skills/index.js'
import type { SkillDefinition } from '../skills/index.js'
import { DEFAULT_SESSION_TITLE, type Store } from '../store/index.js'
import type { SystemRuntimeClient } from '../system.js'
import { ContextBuilder, type ProviderRuntimeConfig } from './context.js'
import type { McpManager } from '../mcp/manager.js'
import { ChildLimitError, CommandError } from './errors.js'
import { MemoryService } from './memory/service.js'
import { ApprovalGateway, PermissionGate } from './permissions.js'
import type { PermissionMode } from './permissions.js'
import { PRIMARY_AGENT_SYSTEM_PROMPT } from './prompts/index.js'
import { QueueService } from './queue.js'
import { RunRunner } from './runner.js'
import { createToolRegistry } from './tools/index.js'
import { deriveSessionTitle } from './title.js'
import type { ToolContext } from './tools/shared.js'

export { CommandError } from './errors.js'

interface RunningStream {
  controller: AbortController
}

/** 子 Agent 默认工具白名单：纯计算 + 只读文件查询，不暴露写/Shell/MCP，且无 task(不递归)。 */
const CHILD_DEFAULT_TOOLS: ReadonlySet<string> = new Set([
  'get_current_time',
  'web.fetch',
  'skill.use',
  'manage_plan',
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
])

/**
 * Agent 门面：对外保持 message.send / run.cancel / run.retry / approval.resolve 的命令契约，
 * 对内把执行委托给 ContextBuilder（历史重建+压缩）与 RunRunner（工具循环编排+审批）。
 */
export class ChatAgent {
  private readonly streams = new Map<string, RunningStream>()
  /** Run 级委派上下文：不写入协议/数据库，避免子 Run 自行升级权限或深度。 */
  private readonly runDepth = new Map<string, number>()
  private readonly runPermissionModes = new Map<string, PermissionMode>()
  private readonly contextBuilder: ContextBuilder
  private readonly runner: RunRunner
  private readonly memory: MemoryService
  private readonly queues: QueueService
  /** 审批网关跨 Run 共享（pending 以 toolCallId 为键；会话级授权存内存）。 */
  readonly approvals = new ApprovalGateway()

  constructor(
    private readonly store: Store,
    private readonly notifier: EventNotifier,
    private readonly system: SystemRuntimeClient | null,
    private readonly mcp: McpManager | null = null,
  ) {
    this.contextBuilder = new ContextBuilder(store)
    this.runner = new RunRunner(store)
    this.memory = new MemoryService(store)
    this.queues = new QueueService(notifier)
  }

  /** 解析本次对话使用的 Provider 与模型；不指定时回退到启用的 Provider 第一个模型。 */
  private resolveProvider(providerId?: string, model?: string) {
    const profile = providerId
      ? this.store.providers.get(providerId)
      : this.store.providers.getEnabled()
    if (!profile) {
      throw new CommandError(
        'configuration',
        providerId
          ? `未找到模型 Provider：${providerId}`
          : '未配置可用的模型 Provider，请先在设置中配置 API Key',
      )
    }
    if (!profile.enabled) {
      throw new CommandError(
        'configuration',
        `模型 Provider 已禁用：${profile.name}`,
      )
    }
    const apiKey = loadSecret(profile.secretRef)
    if (!apiKey) {
      throw new CommandError(
        'configuration',
        'Provider 密钥缺失，请重新在设置中保存 API Key',
      )
    }
    const resolvedModel = model ?? profile.models[0]
    if (!resolvedModel) {
      throw new CommandError(
        'configuration',
        `Provider 未配置模型：${profile.name}`,
      )
    }
    return { profile, apiKey, model: resolvedModel }
  }

  /** 模型采样参数：消息级覆盖优先，缺省用 Provider 配置。 */
  private resolveSampling(
    profile: ProviderProfile,
    overrides: { temperature?: number; maxTokens?: number },
  ): { temperature?: number; maxTokens?: number } {
    const resolved: { temperature?: number; maxTokens?: number } = {}
    if (overrides.temperature !== undefined) {
      resolved.temperature = overrides.temperature
    } else if (profile.temperature !== null) {
      resolved.temperature = profile.temperature
    }
    if (overrides.maxTokens !== undefined) {
      resolved.maxTokens = overrides.maxTokens
    } else if (profile.maxTokens !== null) {
      resolved.maxTokens = profile.maxTokens
    }
    return resolved
  }

  private requireSession(sessionId: string): Session {
    const session = this.store.sessions.get(sessionId)
    if (!session) {
      throw new CommandError(
        'invalid_request',
        `session not found: ${sessionId}`,
      )
    }
    return session
  }

  private requireIdleSession(sessionId: string): void {
    if (this.store.runs.activeForSession(sessionId)) {
      throw new CommandError(
        'invalid_request',
        '该会话有正在进行的回复，请等待完成或先停止',
      )
    }
  }

  /**
   * 发送入口：会话空闲 → 立即开始(startSend)；忙碌 → 自动入队(FIFO)，
   * 当前回复结束由 pumpQueue 自动出队发送。排队期间可修改/删除/立即发送。
   */
  send(params: ChatCommand): {
    queued: boolean
    messageId: string | null
    runId: string | null
    queueId: string | null
    position: number | null
  } {
    this.requireSession(params.sessionId)
    // 入队前先校验技能与 Provider/模型配置,参数错误当场反馈。
    this.resolveSkillInvocation(params.content, params.skillId)
    this.resolveProvider(params.providerId, params.model)
    if (this.store.runs.activeForSession(params.sessionId) === null) {
      const started = this.startSend(params)
      return { queued: false, ...started, queueId: null, position: null }
    }
    const rest: Omit<ChatCommand, 'requestId' | 'sessionId'> = {
      content: params.content,
      providerId: params.providerId,
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      permissionMode: params.permissionMode,
      trusted: params.trusted,
      skillId: params.skillId,
    }
    const entry = this.queues.enqueue(params.sessionId, rest)
    const snapshot = this.queues.list(params.sessionId)
    const position =
      snapshot.find((item) => item.id === entry.id)?.position ?? null
    return {
      queued: true,
      messageId: null,
      runId: null,
      queueId: entry.id,
      position,
    }
  }

  /** 队列快照。 */
  listQueue(sessionId: string) {
    return { items: this.queues.list(sessionId) }
  }

  /** 修改排队内容：优先沿用显式 skillId,否则按新内容重新解析斜杠。 */
  updateQueue(sessionId: string, queueId: string, content: string) {
    const existing = this.queues.get(sessionId, queueId)
    if (!existing) return { item: null }
    const explicitSkillId = existing.params.skillId
    // 重解析并记录"生效的技能"：展示与出队执行口径一致
    // (显式 skillId 优先,否则按新内容识别斜杠)。
    const resolvedSkillId =
      this.resolveSkillInvocation(content, explicitSkillId).skill?.manifest
        .id ?? explicitSkillId
    const updated = this.queues.update(sessionId, queueId, {
      ...existing.params,
      content,
      skillId: resolvedSkillId,
    })
    if (!updated) return { item: null }
    const item =
      this.queues.list(sessionId).find((entry) => entry.id === queueId) ?? null
    return { item }
  }

  removeQueue(sessionId: string, queueId: string) {
    return { removed: this.queues.remove(sessionId, queueId) }
  }

  /** 会话删除时丢弃其排队项(避免无主残留)。 */
  clearQueue(sessionId: string): void {
    this.queues.removeSession(sessionId)
  }

  getSettings() {
    return { settings: this.store.agentSettings.get() }
  }

  updateSettings(settings: AgentSettings) {
    return { settings: this.store.agentSettings.upsert(settings) }
  }

  /** 立即发送：移到队首;空闲则立刻 pump(否则等当前结束)。 */
  sendNow(sessionId: string, queueId: string) {
    const accepted = this.queues.moveToFront(sessionId, queueId)
    if (accepted) this.pumpQueue(sessionId)
    return { accepted }
  }

  /** 当前回复结束后自动发送队首(FIFO)。 */
  private pumpQueue(sessionId: string): void {
    if (this.queues.list(sessionId).length === 0) return
    if (this.store.runs.activeForSession(sessionId) !== null) return
    const entry = this.queues.dequeue(sessionId)
    if (!entry) return
    try {
      this.startSend({ requestId: randomUUID(), sessionId, ...entry.params })
    } catch (error) {
      // 出队后执行失败(配置被改等):写 stderr,前端经 queue.changed 看到该项已移除。
      process.stderr.write(
        `[runtime] queued message send failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }

  /** 同步创建 user/assistant 消息与 Run 并返回；工具循环在后台继续。 */
  startSend(params: ChatCommand): { messageId: string; runId: string } {
    const session = this.requireSession(params.sessionId)
    // Skill 激活先于 Provider 解析：参数写错立刻反馈，不与配置错误混淆。
    const { skill } = this.resolveSkillInvocation(
      params.content,
      params.skillId,
    )
    const { profile, apiKey, model } = this.resolveProvider(
      params.providerId,
      params.model,
    )
    const sampling = this.resolveSampling(profile, params)
    this.requireIdleSession(params.sessionId)

    const run = this.store.runs.create({
      sessionId: params.sessionId,
      providerId: profile.id,
      model,
      skillId: skill?.manifest.id ?? null,
    })
    const userMessage = this.store.messages.create({
      sessionId: params.sessionId,
      runId: run.id,
      role: 'user',
      content: params.content,
      status: 'completed',
    })
    if (session.title === DEFAULT_SESSION_TITLE) {
      const title = deriveSessionTitle(params.content)
      if (title) this.store.sessions.rename(params.sessionId, title)
    }
    this.store.sessions.touch(params.sessionId)
    const assistantMessage = this.createAssistantMessage(params.sessionId, run)

    const emitter = new RunEventEmitter(run.id, this.notifier)
    emitter.next({ type: 'run.started', run })
    emitter.next({ type: 'message.created', message: userMessage })
    emitter.next({ type: 'message.created', message: assistantMessage })
    this.launch({
      run,
      session,
      profile,
      apiKey,
      model,
      sampling,
      permissionMode: params.permissionMode,
      trusted: params.trusted,
      skill,
      assistantMessage,
      emitter,
      childRunStarter: this.store.agentSettings.get().enableChildRuns
        ? this.createChildRunStarter(run, session, profile, apiKey)
        : undefined,
    })

    return { messageId: assistantMessage.id, runId: run.id }
  }

  startRetry(params: { requestId: string; runId: string }): {
    messageId: string
    runId: string
    retryOfRunId: string
  } {
    const original = this.store.runs.get(params.runId)
    if (!original) {
      throw new CommandError(
        'invalid_request',
        `run not found: ${params.runId}`,
      )
    }
    if (original.status === 'created' || original.status === 'running') {
      throw new CommandError('invalid_request', '原 Run 仍在进行中，无法重试')
    }
    const originalSession = this.requireSession(original.sessionId)
    const { profile, apiKey, model } = this.resolveProvider(
      original.providerId ?? undefined,
      original.model ?? undefined,
    )
    this.requireIdleSession(original.sessionId)

    const run = this.store.transaction(() =>
      this.store.runs.replaceWithRetry(
        original.id,
        {
          sessionId: original.sessionId,
          providerId: profile.id,
          model,
          skillId: original.skillId,
          planId: original.planId,
          planStepId: original.planStepId,
        },
        this.store.messages,
      ),
    )

    this.store.sessions.touch(original.sessionId)
    const assistantMessage = this.createAssistantMessage(
      original.sessionId,
      run,
    )

    const emitter = new RunEventEmitter(run.id, this.notifier)
    emitter.next({ type: 'run.started', run })
    emitter.next({ type: 'message.created', message: assistantMessage })
    this.launch({
      run,
      session: originalSession,
      profile,
      apiKey,
      model,
      sampling: this.resolveSampling(profile, {}),
      permissionMode: undefined,
      // 重试不继承信任开关：与 permissionMode 同口径，按默认审批模式重跑。
      trusted: undefined,
      skill:
        original.skillId === null ? null : builtinSkills.get(original.skillId),
      assistantMessage,
      emitter,
      childRunStarter: this.store.agentSettings.get().enableChildRuns
        ? this.createChildRunStarter(run, originalSession, profile, apiKey)
        : undefined,
    })

    return {
      messageId: assistantMessage.id,
      runId: run.id,
      retryOfRunId: original.id,
    }
  }

  cancel(runId: string): { accepted: boolean } {
    // 只有确实在运行中（含等待审批）的 Run 才受理；终态或不存在返回 false。
    const stream = this.streams.get(runId)
    if (!stream) return { accepted: false }
    stream.controller.abort()
    return { accepted: true }
  }

  private createAssistantMessage(sessionId: string, run: Run) {
    return this.store.messages.create({
      sessionId,
      runId: run.id,
      role: 'assistant',
      content: '',
      status: 'pending',
    })
  }

  /** 后台启动执行：按 Run 装配工具/闸门，历史构建与工具循环共享失败/取消路径。 */
  private launch(input: {
    run: Run
    session: Session
    profile: ProviderProfile
    apiKey: string
    model: string
    sampling: { temperature?: number; maxTokens?: number }
    permissionMode: ChatCommand['permissionMode']
    /** 会话信任开关：workspace Profile 下写/Shell 自动放行（不弹审批）。 */
    trusted: ChatCommand['trusted']
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
  }): void {
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
    this.runPermissionModes.set(run.id, input.permissionMode ?? 'workspace')
    const settings = this.store.agentSettings.get()
    const provider: ProviderRuntimeConfig = {
      baseUrl: profile.baseUrl,
      apiKey,
      model,
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
    const workspaceRoot = this.resolveWorkspaceRoot(session)
    const registry = createToolRegistry({
      store: this.store,
      sessionId,
      messageId: assistantMessage.id,
      runId: run.id,
      emitter,
      system: this.system,
      workspaceRoot,
      skills: builtinSkills,
      mcp: this.mcp,
      childRunStarter: input.childRunStarter,
      allowedTools: input.allowedTools,
    })
    const gate = new PermissionGate(
      input.permissionMode ?? 'workspace',
      workspaceRoot !== null,
      input.trusted ?? false,
    )
    void this.runner
      .execute({
        run,
        provider,
        buildHistory: (signal) =>
          this.contextBuilder.build(
            sessionId,
            input.systemPrompt ?? this.composeSystemPrompt(input.skill),
            provider,
            signal,
          ),
        registry,
        workspaceRoot,
        gate,
        approvals: this.approvals,
        memory: this.memory,
        controller,
        emitter,
        firstAssistantMessage: assistantMessage,
        settings,
        onResult: input.onResult,
        onCancel: input.onCancel,
        childTokenBudget: input.childTokenBudget,
      })
      // runner 自吞全部执行期异常；此处仅保证取消句柄必然清理。
      .catch(() => {})
      .finally(() => {
        parentSignal?.removeEventListener('abort', abortChild)
        this.streams.delete(run.id)
        this.runDepth.delete(run.id)
        this.runPermissionModes.delete(run.id)
        // Run 结束(完成/失败/取消):自动出队发送排队中的下一条。
        this.pumpQueue(run.sessionId)
      })
  }

  private createChildRunStarter(
    parentRun: Run,
    parentSession: Session,
    profile: ProviderProfile,
    apiKey: string,
  ): NonNullable<ToolContext['childRunStarter']> {
    // 委派边界上下文：深度与权限模式取父 Run 记录（顶层深度 0、权限默认 workspace），
    // 子 Run 只继承不升级——read-only 父的 child 仍 read-only。
    // 父 Run 级的子 Run 计数（maxChildRuns / maxParallelChildren）随闭包持有，
    // 单次父执行内累计，父 Run 结束后随闭包释放，无需跨 Run 清理。
    let childCount = 0
    let activeChildren = 0
    const settings = this.store.agentSettings.get()
    return async ({ task, agentId, parentRunId, signal }) => {
      const parentDepth = this.runDepth.get(parentRun.id) ?? 0
      const parentMode =
        this.runPermissionModes.get(parentRun.id) ?? 'workspace'
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const agent = this.store.agents.get(agentId)
      if (!agent || !agent.enabled) {
        throw new Error(`agent not found or disabled: ${agentId}`)
      }
      // 委派限额强制：深度 / 总子数 / 并行数，超出抛稳定 code（由 task 工具透传）。
      const childDepth = parentDepth + 1
      if (settings.maxDepth != null && childDepth > settings.maxDepth) {
        throw new ChildLimitError(
          'child_limit_depth',
          `子 Agent 委派深度超过上限 ${settings.maxDepth}`,
        )
      }
      if (
        settings.maxChildRuns != null &&
        childCount >= settings.maxChildRuns
      ) {
        throw new ChildLimitError(
          'child_limit_runs',
          `子 Agent 数量超过上限 ${settings.maxChildRuns}`,
        )
      }
      if (
        settings.maxParallelChildren != null &&
        activeChildren >= settings.maxParallelChildren
      ) {
        throw new ChildLimitError(
          'child_limit_parallel',
          `子 Agent 并行数超过上限 ${settings.maxParallelChildren}`,
        )
      }
      childCount += 1
      activeChildren += 1

      const session = this.store.sessions.create(
        parentSession.projectId,
        `子任务：${task.slice(0, 40)}`,
      )
      const delegation = this.store.delegations.create({
        sessionId: parentSession.id,
        parentRunId,
        agentId: agentId ?? 'default',
        task,
      })
      const run = this.store.runs.create({
        sessionId: session.id,
        providerId: profile.id,
        model: profile.models[0] ?? null,
        parentRunId,
        delegationId: delegation.id,
        agentId: agentId ?? null,
      })
      this.store.delegations.attachChildRun(delegation.id, run.id)
      this.store.delegations.update(delegation.id, 'running')
      this.store.messages.create({
        sessionId: session.id,
        runId: run.id,
        role: 'user',
        content: task,
        status: 'completed',
      })
      const assistant = this.createAssistantMessage(session.id, run)
      const emitter = new RunEventEmitter(run.id, this.notifier)
      emitter.next({ type: 'delegation.created', delegation })

      // 子 Run 独立 AbortController：父取消传导为取消；超时以 ChildLimitError 中止
      //（不触碰父 signal，避免把子超时误标为父取消）。
      const childController = new AbortController()
      const onParentAbort = (): void => {
        childController.abort(signal.reason)
      }
      signal.addEventListener('abort', onParentAbort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      if (settings.maxChildTimeoutSec != null) {
        timer = setTimeout(
          () =>
            childController.abort(
              new ChildLimitError(
                'child_timeout',
                `子 Run 超时(${settings.maxChildTimeoutSec}s)`,
              ),
            ),
          settings.maxChildTimeoutSec * 1000,
        )
      }
      try {
        return await new Promise<string>((resolve, reject) => {
          this.launch({
            run,
            session,
            profile,
            apiKey,
            model: profile.models[0] ?? profile.models[0]!,
            sampling: this.resolveSampling(profile, {}),
            // 继承父权限模式，只降不升：read-only 父的子 Run 仍 read-only；
            // 信任开关不继承（子 Run 白名单本就无写/Shell，不能放大）。
            permissionMode: parentMode,
            trusted: false,
            depth: childDepth,
            skill: null,
            systemPrompt: agent.systemPrompt,
            assistantMessage: assistant,
            emitter,
            // child 默认无 task：不注入 childRunStarter，子 Run 不能再委派；
            // 工具白名单只允许只读能力，写/Shell/MCP 对子 Agent 默认关闭。
            childRunStarter: undefined,
            allowedTools: CHILD_DEFAULT_TOOLS,
            parentSignal: childController.signal,
            childTokenBudget: settings.maxChildTotalTokens ?? undefined,
            onResult: (value) => {
              const updated = this.store.delegations.update(
                delegation.id,
                'completed',
                value,
              )
              emitter.next({
                type: 'delegation.updated',
                delegation: updated,
              })
              resolve(value)
            },
            onFailure: (error) => {
              const updated = this.store.delegations.update(
                delegation.id,
                'failed',
                null,
                error.message,
              )
              emitter.next({ type: 'delegation.updated', delegation: updated })
              reject(error)
            },
            onCancel: () => {
              const updated = this.store.delegations.update(
                delegation.id,
                'cancelled',
                null,
                '父 Run 已取消',
              )
              emitter.next({ type: 'delegation.updated', delegation: updated })
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              )
            },
          })
        })
      } finally {
        activeChildren -= 1
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  /** system prompt = 主 prompt + 可用 Skills 清单 +（可选）本次激活技能的完整说明。 */
  private composeSystemPrompt(skill: SkillDefinition | null): string {
    const base = `${PRIMARY_AGENT_SYSTEM_PROMPT}${skillsPromptSection(builtinSkills.list())}`
    return skill === null ? base : `${base}${activeSkillPromptSection(skill)}`
  }

  /** 消息发送的 Skill 激活解析；显式 skillId 未知视为 invalid_request。 */
  private resolveSkillInvocation(
    content: string,
    explicitSkillId: string | undefined,
  ): ReturnType<typeof resolveInvocation> {
    try {
      return resolveInvocation(content, explicitSkillId, builtinSkills)
    } catch (error) {
      throw new CommandError(
        'invalid_request',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** 会话的工作区根：项目 folderPath；独立会话/空路径返回 null（工具被拒绝）。 */
  private resolveWorkspaceRoot(session: Session): string | null {
    if (session.projectId === null) return null
    const project = this.store.projects.get(session.projectId)
    if (!project || project.folderPath === '') return null
    return project.folderPath
  }
}
