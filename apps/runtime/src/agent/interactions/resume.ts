import type { Store } from '../../store/index.js'
import { RunEventEmitter, type EventNotifier } from '../../events.js'
import type { SkillRegistry } from '../../skills/index.js'
import type { InteractionGateway } from './index.js'
import { createPendingAssistantMessage, type RunLauncher } from '../launcher.js'
import { DEFAULT_PRESET } from '../permissions/index.js'
import { resolveProvider, resolveSampling } from '../provider-resolver.js'
import { normalizeToolOutput } from '../run/toolResults.js'
import { formatAnswers } from '../tools/ask-user.js'
import { applyPlanApproval } from '../tools/plan-mode.js'

/** 回答结构化问题；若等待来自上次进程，则补齐工具结果并续跑原 Run。 */
export async function resumeInteraction(
  deps: {
    system: import('../../system.js').SystemRuntimeClient | null
    store: Store
    notifier: EventNotifier
    interactions: InteractionGateway
    skills: SkillRegistry
    launch: (
      input: Omit<Parameters<RunLauncher['launch']>[0], 'childRunStarter'>,
    ) => void
  },
  interactionId: string,
  answers: import('@reflexion-os-studio/contracts').UserQuestionAnswer[],
): Promise<{ accepted: boolean }> {
  const interaction = deps.store.interactions.get(interactionId)
  if (!interaction || interaction.status !== 'pending') {
    return { accepted: false }
  }
  const run = deps.store.runs.get(interaction.runId)
  const session = run ? deps.store.sessions.get(run.sessionId) : null
  if (!run || !session || run.status !== 'awaiting_user_input') {
    return { accepted: false }
  }
  const response = deps.interactions.respond(interactionId, answers)
  if (!response.accepted || response.recovered === null) {
    return { accepted: response.accepted }
  }

  const toolCall = deps.store.toolCalls.get(interaction.toolCallId)
  if (!toolCall) return { accepted: false }
  const { profile, apiKey, model } = resolveProvider(
    deps.store,
    run.providerId ?? undefined,
    run.model ?? undefined,
  )
  const result =
    interaction.kind === 'plan_approval' &&
    typeof toolCall.args === 'object' &&
    toolCall.args !== null &&
    !Array.isArray(toolCall.args) &&
    typeof toolCall.args.planId === 'string'
      ? await applyPlanApproval(
          deps.store,
          session.id,
          toolCall.args.planId,
          answers,
          interaction.questions.find(
            (question) => question.id === 'plan-decision',
          )?.plan,
          deps.system,
        )
      : {
          content: formatAnswers(interaction.questions, answers),
          isError: false,
          data: { answers },
        }
  const assistantMessage = deps.store.transaction(() => {
    const output = normalizeToolOutput(
      result,
      session.projectId,
      toolCall.toolName,
    )
    deps.store.interactions.resolve(interactionId, answers)
    deps.store.toolCalls.finalize(interaction.toolCallId, 'completed', output)
    deps.store.runs.setIntermediateStatus(run.id, 'running')
    const previousTurn = deps.store.turnExecutions.latestForRun(run.id)
    if (previousTurn !== null && previousTurn.completedAt === null) {
      deps.store.turnExecutions.transition(previousTurn.id, 'completed', {
        pendingInteractionId: null,
        continuationReason: 'user_input_resolved',
      })
    }
    return createPendingAssistantMessage(deps.store, session.id, run)
  })
  const resumedRun = deps.store.runs.get(run.id) ?? run
  const emitter = new RunEventEmitter(run.id, deps.notifier)
  emitter.next({
    type: 'interaction.resolved',
    interactionId,
    toolCallId: interaction.toolCallId,
    answers,
  })
  emitter.next({
    type: 'tool.completed',
    toolCallId: interaction.toolCallId,
    status: 'completed',
    errorCode: null,
  })
  emitter.next({ type: 'run.started', run: resumedRun })
  emitter.next({ type: 'message.created', message: assistantMessage })
  deps.launch({
    run: resumedRun,
    session,
    profile,
    apiKey,
    model,
    sampling: resolveSampling(profile, {}),
    permissionPreset: DEFAULT_PRESET,
    defaultChildTemplateId: run.agentTemplateId ?? undefined,
    skill:
      run.skillId === null
        ? null
        : deps.skills.get(run.skillId, session.projectId),
    assistantMessage,
    emitter,
  })
  return { accepted: true }
}
