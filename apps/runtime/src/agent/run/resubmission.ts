import type {
  MessageEditResendParams,
  RunRetryParams,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../../events.js'
import type { Store } from '../../store/index.js'
import type { SkillRegistry } from '../../skills/index.js'
import { CommandError } from '../errors.js'
import { createPendingAssistantMessage, type RunLauncher } from '../launcher.js'
import { DEFAULT_PRESET, resolveInputPreset } from '../permissions/index.js'
import { resolveProvider, resolveSampling } from '../provider-resolver.js'
import {
  requireSession,
  requireIdleSession,
  resolveSkillInvocation,
} from '../guards.js'

/** 新建替代 Run，保留历史重试链与编辑重发语义。 */
export class RunResubmissionService {
  constructor(
    private readonly store: Store,
    private readonly notifier: EventNotifier,
    private readonly skills: SkillRegistry,
    private readonly launch: (
      input: Omit<Parameters<RunLauncher['launch']>[0], 'childRunStarter'>,
    ) => void,
  ) {}

  startRetry(params: RunRetryParams): {
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
      params.providerId ?? original.providerId ?? undefined,
      params.model ??
        (params.providerId === undefined ||
        params.providerId === original.providerId
          ? (original.model ?? undefined)
          : undefined),
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
          agentTemplateId: original.agentTemplateId,
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
      defaultChildTemplateId: original.agentTemplateId ?? undefined,
      skill:
        original.skillId === null
          ? null
          : this.skills.get(original.skillId, originalSession.projectId),
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
      session.projectId,
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
          agentTemplateId: params.agentTemplateId ?? null,
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
          parts: [
            { type: 'text', text: content },
            ...lastUserMessage.parts.filter((part) => part.type === 'image'),
          ],
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
      defaultChildTemplateId: params.agentTemplateId,
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
}
