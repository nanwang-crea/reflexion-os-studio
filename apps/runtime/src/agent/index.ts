import type {
  ChatCommand,
  Message,
  ProviderProfile,
  Run,
  Session,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../events.js'
import { loadSecret } from '../secrets.js'
import { DEFAULT_SESSION_TITLE, type Store } from '../store/index.js'
import type { SystemRuntimeClient } from '../system.js'
import { ContextBuilder, type ProviderRuntimeConfig } from './context.js'
import { CommandError } from './errors.js'
import { MemoryService } from './memory/service.js'
import { ApprovalGateway, PermissionGate } from './permissions.js'
import { PRIMARY_AGENT_SYSTEM_PROMPT } from './prompts/index.js'
import { RunRunner } from './runner.js'
import { createToolRegistry } from './tools.js'
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
  /** 审批网关跨 Run 共享（pending 以 toolCallId 为键；会话级授权存内存）。 */
  readonly approvals = new ApprovalGateway()

  constructor(
    private readonly store: Store,
    private readonly notifier: EventNotifier,
    private readonly system: SystemRuntimeClient | null,
  ) {
    this.contextBuilder = new ContextBuilder(store)
    this.runner = new RunRunner(store)
    this.memory = new MemoryService(store)
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

  /** 同步创建 user/assistant 消息与 Run 并返回；工具循环在后台继续。 */
  startSend(params: ChatCommand): { messageId: string; runId: string } {
    const session = this.requireSession(params.sessionId)
    const { profile, apiKey, model } = this.resolveProvider(
      params.providerId,
      params.model,
    )
    this.requireIdleSession(params.sessionId)

    const run = this.store.runs.create({
      sessionId: params.sessionId,
      providerId: profile.id,
      model,
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
      permissionMode: params.permissionMode,
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
    // 重试沿用原 Run 的 Provider/模型；旧 Run 未记录时回退到当前启用配置。
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
      permissionMode: undefined,
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
    const stream = this.streams.get(runId)
    if (stream) {
      stream.controller.abort()
      return { accepted: true }
    }
    return { accepted: this.store.runs.get(runId) !== null }
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
    permissionMode: ChatCommand['permissionMode']
    assistantMessage: Message
    emitter: RunEventEmitter
  }): void {
    const { run, session, profile, apiKey, model, assistantMessage, emitter } =
      input
    const controller = new AbortController()
    this.streams.set(run.id, { controller })
    const provider: ProviderRuntimeConfig = {
      baseUrl: profile.baseUrl,
      apiKey,
      model,
    }
    const sessionId = run.sessionId
    const workspaceRoot = this.resolveWorkspaceRoot(session)
    const registry = createToolRegistry({
      system: this.system,
      workspaceRoot,
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
            PRIMARY_AGENT_SYSTEM_PROMPT,
            provider,
            signal,
          ),
        registry,
        gate,
        approvals: this.approvals,
        memory: this.memory,
        controller,
        emitter,
        firstAssistantMessage: assistantMessage,
      })
      // runner 自吞全部执行期异常；此处仅保证取消句柄必然清理。
      .catch(() => {})
      .finally(() => {
        this.streams.delete(run.id)
      })
  }

  /** 会话的工作区根：项目 folderPath；独立会话/空路径返回 null（工具被拒绝）。 */
  private resolveWorkspaceRoot(session: Session): string | null {
    if (session.projectId === null) return null
    const project = this.store.projects.get(session.projectId)
    if (!project || project.folderPath === '') return null
    return project.folderPath
  }
}
