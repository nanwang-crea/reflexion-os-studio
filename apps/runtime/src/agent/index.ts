import { randomUUID } from 'node:crypto'
import type {
  AgentSettings,
  ChatCommand,
  Session,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../events.js'
import { builtinSkills, resolveInvocation } from '../skills/index.js'
import { DEFAULT_SESSION_TITLE, type Store } from '../store/index.js'
import type { SystemRuntimeClient } from '../system.js'
import type { McpManager } from '../mcp/manager.js'
import { ContextBuilder } from './context.js'
import { CommandError } from './errors.js'
import { createPendingAssistantMessage, RunLauncher } from './launcher.js'
import { MemoryService } from './memory/service.js'
import { ApprovalGateway } from './permissions.js'
import { resolveProvider, resolveSampling } from './provider-resolver.js'
import { QueueService } from './queue.js'
import { RunRunner } from './runner.js'
import { deriveSessionTitle } from './title.js'

export { CommandError, ChildLimitError } from './errors.js'

/**
 * Agent 门面：对外保持 message.send / run.cancel / run.retry / approval.resolve 的命令契约，
 * 对内把执行委托给 ContextBuilder（历史重建+压缩）、RunLauncher（Run 装配）、
 * RunRunner（工具循环编排+审批）、QueueService（发送队列）与 delegation（子 Agent 委派）。
 */
export class ChatAgent {
  /** 审批网关跨 Run 共享（pending 以 toolCallId 为键；会话级授权存内存）。 */
  readonly approvals = new ApprovalGateway()
  private readonly contextBuilder: ContextBuilder
  private readonly runner: RunRunner
  private readonly memory: MemoryService
  private readonly queues: QueueService
  private readonly launcher: RunLauncher

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
    this.launcher = new RunLauncher(
      {
        store,
        system,
        mcp,
        runner: this.runner,
        contextBuilder: this.contextBuilder,
        memory: this.memory,
        approvals: this.approvals,
      },
      { onRunSettled: (sessionId) => this.pumpQueue(sessionId) },
    )
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
    resolveProvider(this.store, params.providerId, params.model)
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
    const { profile, apiKey, model } = resolveProvider(
      this.store,
      params.providerId,
      params.model,
    )
    const sampling = resolveSampling(profile, params)
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
    const assistantMessage = createPendingAssistantMessage(
      this.store,
      params.sessionId,
      run,
    )

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
    const { profile, apiKey, model } = resolveProvider(
      this.store,
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
    const assistantMessage = createPendingAssistantMessage(
      this.store,
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
      sampling: resolveSampling(profile, {}),
      permissionMode: undefined,
      // 重试不继承信任开关：与 permissionMode 同口径，按默认审批模式重跑。
      trusted: undefined,
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
    return { accepted: this.launcher.cancel(runId) }
  }

  /** 组装并后台启动一次 Run（Phase 3 未启动：child task 强制不可达）。 */
  private launch(
    input: Omit<Parameters<RunLauncher['launch']>[0], 'childRunStarter'>,
  ): void {
    // Phase 3 边界：子 Agent 委派未正式启用。即使旧 settings JSON 中
    // enableChildRuns=true 也不得给 Primary Agent 注册 task 工具。
    // 重新启用需先完成 ROADMAP Phase 3 设计评审，不得靠设置开关绕过。
    this.launcher.launch({ ...input, childRunStarter: undefined })
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
}
