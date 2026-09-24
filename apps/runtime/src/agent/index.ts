import { randomUUID } from 'node:crypto'
import type {
  AgentSettings,
  ChatCommand,
  DangerCapability,
  MessageEditResendParams,
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
import {
  ApprovalGateway,
  DangerLeaseService,
  DEFAULT_PRESET,
  resolveInputPreset,
} from './permissions/index.js'
import { resolveProvider, resolveSampling } from './provider-resolver.js'
import { QueueService } from './queue.js'
import { RunRunner } from './runner.js'
import { SessionTitleService } from './session-titles.js'
import { deriveSessionTitle } from './title.js'

export { CommandError, ChildLimitError } from './errors.js'
export { DEFAULT_PRESET } from './permissions/index.js'

/**
 * W5 Danger capability 探测（fail-closed）：只有"保留敏感读/写 deny 的 Danger
 * 档位已在该平台真机证明"才支持。当前：macOS Seatbelt（real_machine_tests 已验）
 * 支持；Linux bwrap 的 danger 渲染已实现并金样钉住，但真机验收未完成 → 保持
 * 关闭（Rust 侧 supports_access 同步为 false，双层兜底）；Windows 无可验证的
 * 凭据拒读机制（受限令牌只收紧写边界）→ 永久 fail-closed，直至 guard spike
 * 通过。危险能力"三平台完成"以各平台真机证据为准，不以代码存在为准。
 */
function dangerCapability(
  system: SystemRuntimeClient | null,
): DangerCapability {
  const provider = system?.sandboxName ?? null
  if (provider === 'seatbelt') {
    return {
      supported: true,
      provider: 'seatbelt',
      detail:
        'macOS Seatbelt danger profile：非敏感系统读写放开、敏感路径读写 deny 保留（真机已验证）',
    }
  }
  if (provider === 'bwrap') {
    return {
      supported: false,
      provider: null,
      detail:
        'Linux bwrap danger 档已实现并经单测钉住，待 Linux 真机验收后启用（当前构建不可启用）',
    }
  }
  const suffix = provider ? `（当前沙箱 provider：${provider}）` : ''
  return {
    supported: false,
    provider: null,
    detail:
      '当前平台缺少可验证的 credential-guard 危险档边界，拒绝启用' + suffix,
  }
}

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
      },
      {
        onRunSettled: (sessionId) => this.pumpQueue(sessionId),
      },
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
      // 重试不继承高权限档：回落默认预设（workspace-read）重跑；
      // 会话级 ask-everything 覆盖项仍生效（只会更严，不构成提权）。
      permissionPreset: DEFAULT_PRESET,
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

  /** 编辑最后一条用户消息并重发。
   * 产品语义：替换最后一条 user（标记旧 user+assistant 为 superseded），
   * 以新内容作为新一轮发送；与 run.retry 区分（retry 同文案重跑，不改 user）。
   * 会话有进行中的 Run → invalid_request（「请先停止当前回复」）。
   * 排队中的消息继续只走 QueueBar，不走本命令。
   */
  startEditResend(params: MessageEditResendParams) {
    const session = this.requireSession(params.sessionId)
    this.requireIdleSession(params.sessionId)
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
    const { skill } = this.resolveSkillInvocation(content, params.skillId)
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
