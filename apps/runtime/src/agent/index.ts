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
import { CommandError } from './errors.js'
import { MemoryService } from './memory/service.js'
import { ApprovalGateway, PermissionGate } from './permissions.js'
import { PRIMARY_AGENT_SYSTEM_PROMPT } from './prompts/index.js'
import { QueueService } from './queue.js'
import { RunRunner } from './runner.js'
import { createToolRegistry } from './tools/index.js'
import { deriveSessionTitle } from './title.js'

export { CommandError } from './errors.js'

interface RunningStream {
  controller: AbortController
}

/**
 * Agent 门面：对外保持 message.send / run.cancel / run.retry / approval.resolve 的命令契约，
 * 对内把执行委托给 ContextBuilder（历史重建+压缩）与 RunRunner（工具循环编排+审批）。
 */
export class ChatAgent {
  private readonly streams = new Map<string, RunningStream>()
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
      skill,
      assistantMessage,
      emitter,
    })

    return { messageId: assistantMessage.id, runId: run.id }
  }

  /** 基于原 Run 重新生成一次回复；原 Run 与其消息保持不变。 */
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
    // 重试沿用原 Run 的 Provider/模型/Skill；旧 Run 未记录时回退到当前启用配置。
    const { profile, apiKey, model } = this.resolveProvider(
      original.providerId ?? undefined,
      original.model ?? undefined,
    )
    this.requireIdleSession(original.sessionId)

    const run = this.store.runs.create({
      sessionId: original.sessionId,
      providerId: profile.id,
      model,
      retryOfRunId: original.id,
      skillId: original.skillId,
      planId: original.planId,
      planStepId: original.planStepId,
    })
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
      skill:
        original.skillId === null ? null : builtinSkills.get(original.skillId),
      assistantMessage,
      emitter,
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
    skill: SkillDefinition | null
    assistantMessage: Message
    emitter: RunEventEmitter
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
    this.streams.set(run.id, { controller })
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
    })
    const gate = new PermissionGate(
      input.permissionMode ?? 'workspace',
      workspaceRoot !== null,
    )
    void this.runner
      .execute({
        run,
        provider,
        buildHistory: (signal) =>
          this.contextBuilder.build(
            sessionId,
            this.composeSystemPrompt(input.skill),
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
      })
      // runner 自吞全部执行期异常；此处仅保证取消句柄必然清理。
      .catch(() => {})
      .finally(() => {
        this.streams.delete(run.id)
        // Run 结束(完成/失败/取消):自动出队发送排队中的下一条。
        this.pumpQueue(run.sessionId)
      })
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
