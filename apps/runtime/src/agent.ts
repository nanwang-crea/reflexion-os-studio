import type {
  ChatCommand,
  Message,
  RuntimeEvent,
  Run,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from './events.js'
import {
  ProviderError,
  streamChatCompletion,
  type ChatContextMessage,
} from './provider.js'
import { loadSecret } from './secrets.js'
import { DEFAULT_SESSION_TITLE, type Store } from './store/index.js'

export class CommandError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CommandError'
    this.code = code
  }
}

const SYSTEM_PROMPT =
  '你是 ReflexionOS Studio 的 Primary Agent，一个乐于助人的中文助手。'

const TITLE_MAX_LENGTH = 24

/** 用首条用户消息派生会话标题；无有效内容时返回 null（保留默认标题）。 */
function deriveSessionTitle(content: string): string | null {
  const collapsed = content.trim().replace(/\s+/g, ' ')
  if (collapsed === '') return null
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed
  return `${collapsed.slice(0, TITLE_MAX_LENGTH)}…`
}

interface RunningStream {
  controller: AbortController
  emitter: RunEventEmitter
}

export class ChatAgent {
  private readonly streams = new Map<string, RunningStream>()

  constructor(
    private readonly store: Store,
    private readonly notifier: EventNotifier,
  ) {}

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

  private requireSession(sessionId: string) {
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

  private buildContext(sessionId: string): ChatContextMessage[] {
    const context: ChatContextMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ]
    for (const message of this.store.messages.listBySession(sessionId)) {
      if (message.role === 'system') continue
      if (message.role === 'assistant' && message.status !== 'completed')
        continue
      if (message.content === '') continue
      context.push({ role: message.role, content: message.content })
    }
    return context
  }

  /** 同步创建 user/assistant 消息与 Run 并返回，流式在后台继续。 */
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
    const assistantMessage = this.store.messages.create({
      sessionId: params.sessionId,
      runId: run.id,
      role: 'assistant',
      content: '',
      status: 'pending',
    })

    const emitter = new RunEventEmitter(run.id, this.notifier)
    emitter.next({ type: 'run.started', run })
    emitter.next({ type: 'message.created', message: userMessage })
    emitter.next({ type: 'message.created', message: assistantMessage })

    const history = this.buildContext(params.sessionId)
    const controller = new AbortController()
    this.streams.set(run.id, { controller, emitter })
    void this.stream({
      run,
      assistantMessage,
      profileId: profile.id,
      model,
      baseUrl: profile.baseUrl,
      apiKey,
      history,
      controller,
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
    this.requireSession(original.sessionId)
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
    const assistantMessage = this.store.messages.create({
      sessionId: original.sessionId,
      runId: run.id,
      role: 'assistant',
      content: '',
      status: 'pending',
    })

    const emitter = new RunEventEmitter(run.id, this.notifier)
    emitter.next({ type: 'run.started', run })
    emitter.next({ type: 'message.created', message: assistantMessage })

    const history = this.buildContext(original.sessionId)
    const controller = new AbortController()
    this.streams.set(run.id, { controller, emitter })
    void this.stream({
      run,
      assistantMessage,
      profileId: profile.id,
      model,
      baseUrl: profile.baseUrl,
      apiKey,
      history,
      controller,
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

  private async stream(input: {
    run: Run
    assistantMessage: Message
    profileId: string
    model: string
    baseUrl: string
    apiKey: string
    history: ChatContextMessage[]
    controller: AbortController
    emitter: RunEventEmitter
  }): Promise<void> {
    const { run, assistantMessage, controller, emitter } = input
    let accumulated = ''
    let chunkSeq = 0
    let streamingMarked = false

    try {
      const result = await streamChatCompletion(
        {
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          model: input.model,
          messages: input.history,
          signal: controller.signal,
        },
        (delta) => {
          accumulated += delta
          if (!streamingMarked) {
            streamingMarked = true
            this.store.messages.markStreaming(assistantMessage.id)
          }
          emitter.next({
            type: 'message.delta',
            messageId: assistantMessage.id,
            chunkSeq: chunkSeq++,
            delta,
          })
        },
      )

      this.store.transaction(() => {
        this.store.messages.finalize(
          assistantMessage.id,
          result.content,
          'completed',
        )
        this.store.runs.finalize(run.id, 'completed')
      })
      emitter.next({
        type: 'message.completed',
        messageId: assistantMessage.id,
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
      })
      emitter.next({ type: 'run.completed' })
    } catch (error) {
      this.handleStreamFailure(input, accumulated, error)
    } finally {
      this.streams.delete(run.id)
    }
  }

  private handleStreamFailure(
    input: {
      run: Run
      assistantMessage: Message
      emitter: RunEventEmitter
    },
    accumulated: string,
    error: unknown,
  ): void {
    const { run, assistantMessage, emitter } = input

    if (error instanceof Error && error.name === 'AbortError') {
      this.store.transaction(() => {
        this.store.messages.finalize(
          assistantMessage.id,
          accumulated,
          'interrupted',
        )
        this.store.runs.finalize(run.id, 'cancelled')
      })
      emitter.next({ type: 'run.cancelled' })
      return
    }

    const code = error instanceof ProviderError ? error.code : 'internal'
    const message =
      error instanceof Error ? error.message : 'unknown provider failure'
    // Provider/网络错误只经事件与 stderr 暴露，不进 stdout 协议通道。
    process.stderr.write(`[runtime] run failed (${code}): ${message}\n`)
    this.store.transaction(() => {
      this.store.messages.finalize(assistantMessage.id, accumulated, 'failed')
      this.store.runs.finalize(run.id, 'failed', code)
    })
    emitter.next({ type: 'run.failed', error: { code, message } })
  }
}
