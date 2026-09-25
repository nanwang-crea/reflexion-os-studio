import { randomUUID } from 'node:crypto'
import type {
  AgentSettings,
  ChatCommand,
  MessageEditResendParams,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../events.js'
import { createSkillRegistry, type SkillRegistry } from '../skills/index.js'
import { DEFAULT_SESSION_TITLE, type Store } from '../store/index.js'
import type { SystemRuntimeClient } from '../system.js'
import type { McpManager } from '../mcp/manager.js'
import { ContextBuilder } from './context/context.js'
import { CommandError } from './errors.js'
import { createPendingAssistantMessage, RunLauncher } from './launcher.js'
import {
  ApprovalGateway,
  DangerLeaseService,
  DEFAULT_PRESET,
  resolveInputPreset,
} from './permissions/index.js'
import { resolveProvider, resolveSampling } from './provider-resolver.js'
import { QueueService } from './session/queue.js'
import { RunRunner } from './run/runner.js'
import { SessionTitleService } from './session/session-titles.js'
import { deriveSessionTitle } from './session/title.js'
import { createChildRunStarter } from './delegation.js'
import {
  dangerCapability,
  requireIdleSession,
  requireSession,
  resolveSkillInvocation,
} from './guards.js'

export { CommandError, ChildLimitError } from './errors.js'
export { DEFAULT_PRESET } from './permissions/index.js'

/**
 * Agent 门面：对外保持 message.send / run.cancel / run.retry / approval.resolve 的命令契约，
 * 对内把执行委托给 ContextBuilder（历史重建+压缩）、RunLauncher（Run 装配）、
 * RunRunner（工具循环编排+审批）、QueueService（发送队列）与 delegation（子 Agent 委派）。
 */
export class ChatAgent {
  /** 审批网关跨 Run 共享（pending 以 toolCallId 为键；会话规则存内存）。 */
  readonly approvals = new ApprovalGateway()
  /** Danger 高级能力租约：Runtime 是唯一真源，内存态、会话绑定。 */
  readonly danger: DangerLeaseService
  private readonly contextBuilder: ContextBuilder
  private readonly runner: RunRunner
  private readonly queues: QueueService
  private readonly launcher: RunLauncher
  private readonly sessionTitles: SessionTitleService

  constructor(
    private readonly store: Store,
    private readonly notifier: EventNotifier,
    private readonly system: SystemRuntimeClient | null,
    private readonly mcp: McpManager | null = null,
    private readonly skills: SkillRegistry = createSkillRegistry(),
  ) {
    this.danger = new DangerLeaseService(notifier, () =>
      dangerCapability(this.system),
    )
    this.contextBuilder = new ContextBuilder(store)
    this.runner = new RunRunner(store)
    this.queues = new QueueService(notifier)
    this.sessionTitles = new SessionTitleService(store, notifier)
    this.launcher = new RunLauncher(
      {
        store,
        system,
        mcp,
        runner: this.runner,
        contextBuilder: this.contextBuilder,
        approvals: this.approvals,
        danger: this.danger,
        skills: this.skills,
      },
      {
        onRunSettled: (sessionId) => this.pumpQueue(sessionId),
      },
    )
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
    requireSession(this.store, params.sessionId)
    // 入队前先校验技能与 Provider/模型配置,参数错误当场反馈。
    resolveSkillInvocation(params.content, params.skillId, this.skills)
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
      // 入队即固化解析后的档位快照（legacy 字段不再入队）。
      permissionPreset: resolveInputPreset(params),
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
    return {
      items: this.queues.list(sessionId),
      paused: this.queues.isPaused(sessionId),
    }
  }

  /** 解除停止 Run 后的队列暂停;会话空闲且队列非空则立即出队发送。 */
  resumeQueue(sessionId: string): { resumed: boolean } {
    const resumed = this.queues.resume(sessionId)
    if (resumed) this.pumpQueue(sessionId)
    return { resumed }
  }

  /** 修改排队内容：优先沿用显式 skillId,否则按新内容重新解析斜杠。 */
  updateQueue(sessionId: string, queueId: string, content: string) {
    const existing = this.queues.get(sessionId, queueId)
    if (!existing) return { item: null }
    const explicitSkillId = existing.params.skillId
    // 重解析并记录"生效的技能"：展示与出队执行口径一致
    // (显式 skillId 优先,否则按新内容识别斜杠)。
    const resolvedSkillId =
      resolveSkillInvocation(content, explicitSkillId, this.skills).skill
        ?.manifest.id ?? explicitSkillId
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

  /** 立即发送：移到队首;空闲则立刻 pump(否则等当前结束)。显式发送视为解除暂停。 */
  sendNow(sessionId: string, queueId: string) {
    const accepted = this.queues.moveToFront(sessionId, queueId)
    if (accepted) {
      this.queues.resume(sessionId)
      this.pumpQueue(sessionId)
    }
    return { accepted }
  }

  /** 当前回复结束后自动发送队首(FIFO)；用户停止后暂停期间不出队。 */
  private pumpQueue(sessionId: string): void {
    if (this.queues.list(sessionId).length === 0) return
    if (this.queues.isPaused(sessionId)) return
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
    const session = requireSession(this.store, params.sessionId)
    // Skill 激活先于 Provider 解析：参数写错立刻反馈，不与配置错误混淆。
    const { skill } = resolveSkillInvocation(
      params.content,
      params.skillId,
      this.skills,
    )
    const { profile, apiKey, model } = resolveProvider(
      this.store,
      params.providerId,
      params.model,
    )
    const sampling = resolveSampling(profile, params)
    requireIdleSession(this.store, params.sessionId)

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
    const placeholderTitle =
      session.title === DEFAULT_SESSION_TITLE &&
      this.sessionTitles.shouldGenerate(params.sessionId)
        ? deriveSessionTitle(params.content)
        : null
    if (placeholderTitle) {
      this.store.sessions.rename(params.sessionId, placeholderTitle)
      this.sessionTitles.emitUpdated(params.sessionId)
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
      permissionPreset: resolveInputPreset(params),
      skill,
      assistantMessage,
      emitter,
    })

    // 调度异步 LLM 标题生成：不阻塞 startSend 返回、不阻塞 Run。
    // 仅在标题仍为默认值时触发，并标记防止重复。
    if (placeholderTitle) {
      this.sessionTitles.schedule({
        sessionId: params.sessionId,
        content: params.content,
        placeholderTitle,
        profile,
        apiKey,
        model,
      })
    }

    return { messageId: assistantMessage.id, runId: run.id }
  }

  emitSessionUpdated(sessionId: string): void {
    this.sessionTitles.emitUpdated(sessionId)
  }

  markSessionTitleManuallyEdited(sessionId: string): void {
    this.sessionTitles.markManuallyEdited(sessionId)
  }

  clearSessionResources(sessionId: string): void {
    this.clearQueue(sessionId)
    this.sessionTitles.clearSession(sessionId)
  }

  dispose(): void {
    this.sessionTitles.dispose()
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
    const originalSession = requireSession(this.store, original.sessionId)
    const { profile, apiKey, model } = resolveProvider(
      this.store,
      original.providerId ?? undefined,
      original.model ?? undefined,
    )
    requireIdleSession(this.store, original.sessionId)

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
      // 重试不继承高权限档：回落默认预设（workspace-read）重跑；
      // 会话级 ask-everything 覆盖项仍生效（只会更严，不构成提权）。
      permissionPreset: DEFAULT_PRESET,
      skill:
        original.skillId === null ? null : this.skills.get(original.skillId),
      assistantMessage,
      emitter,
    })

    return {
      messageId: assistantMessage.id,
      runId: run.id,
      retryOfRunId: original.id,
    }
  }

  /** 编辑最后一条用户消息并重发。
   * 产品语义：替换最后一条 user（标记旧 user+assistant 为 superseded），
   * 以新内容作为新一轮发送；与 run.retry 区分（retry 同文案重跑，不改 user）。
   * 会话有进行中的 Run → invalid_request（「请先停止当前回复」）。
   * 排队中的消息继续只走 QueueBar，不走本命令。
   */
  startEditResend(params: MessageEditResendParams) {
    const session = requireSession(this.store, params.sessionId)
    requireIdleSession(this.store, params.sessionId)
    const content = params.content.trim()
    if (content === '') {
      throw new CommandError('invalid_request', '消息内容不能为空')
    }
    const messages = this.store.messages.listBySession(params.sessionId)
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'user')
    if (!lastUserMessage || lastUserMessage.id !== params.messageId) {
      throw new CommandError('invalid_request', '只能编辑最后一条用户消息')
    }
    const replacedRunIds: string[] = []
    let replacedRun = lastUserMessage.runId
      ? this.store.runs.get(lastUserMessage.runId)
      : null
    while (replacedRun) {
      replacedRunIds.push(replacedRun.id)
      replacedRun = replacedRun.supersededByRunId
        ? this.store.runs.get(replacedRun.supersededByRunId)
        : null
    }
    const { skill } = resolveSkillInvocation(
      content,
      params.skillId,
      this.skills,
    )
    const { profile, apiKey, model } = resolveProvider(
      this.store,
      params.providerId,
      params.model,
    )
    const sampling = resolveSampling(profile, params)
    const { newRun, newUserMessage, newAssistantMessage } =
      this.store.transaction(() => {
        const newRun = this.store.runs.create({
          sessionId: params.sessionId,
          providerId: profile.id,
          model,
          skillId: skill?.manifest.id ?? null,
        })
        if (replacedRunIds.length > 0) {
          const visibleRunId = replacedRunIds.at(-1)
          if (visibleRunId) {
            this.store.runs.markSuperseded(visibleRunId, newRun.id)
          }
          for (const runId of replacedRunIds) {
            this.store.messages.markSupersededRound(runId)
          }
        } else {
          this.store.messages.markSuperseded(lastUserMessage.id)
        }
        const newUserMessage = this.store.messages.create({
          sessionId: params.sessionId,
          runId: newRun.id,
          role: 'user',
          content,
          status: 'completed',
        })
        const newAssistantMessage = createPendingAssistantMessage(
          this.store,
          params.sessionId,
          newRun,
        )
        return { newRun, newUserMessage, newAssistantMessage }
      })

    this.store.sessions.touch(params.sessionId)
    const emitter = new RunEventEmitter(newRun.id, this.notifier)
    emitter.next({ type: 'run.started', run: newRun })
    emitter.next({ type: 'message.created', message: newUserMessage })
    emitter.next({ type: 'message.created', message: newAssistantMessage })
    this.launch({
      run: newRun,
      session,
      profile,
      apiKey,
      model,
      sampling,
      permissionPreset: resolveInputPreset(params),
      skill,
      assistantMessage: newAssistantMessage,
      emitter,
    })

    return {
      queued: false,
      messageId: newAssistantMessage.id,
      runId: newRun.id,
      queueId: null,
      position: null,
    }
  }

  cancel(runId: string): { accepted: boolean } {
    const run = this.store.runs.get(runId)
    const accepted = this.launcher.cancel(runId)
    // 用户主动停止：该会话队列进入暂停态，出队需 queue.resume 显式确认。
    // 空队列不挂标记——否则用户看不见任何"已暂停"提示，之后新排队的
    // 消息却会被静默扣住（幽灵暂停）。
    if (accepted && run && this.queues.list(run.sessionId).length > 0) {
      this.queues.pause(run.sessionId)
    }
    return { accepted }
  }

  /** 组装并后台启动一次顶层 Run；Phase 3A 仅为顶层注入一层只读委派。 */
  private launch(
    input: Omit<Parameters<RunLauncher['launch']>[0], 'childRunStarter'>,
  ): void {
    const settings = this.store.agentSettings.get()
    const childRunStarter = settings.enableChildRuns
      ? createChildRunStarter(
          {
            store: this.store,
            notifier: this.notifier,
            launcher: this.launcher,
            profile: input.profile,
            apiKey: input.apiKey,
          },
          input.run,
          input.session,
        )
      : undefined
    this.launcher.launch({ ...input, childRunStarter })
  }
}
