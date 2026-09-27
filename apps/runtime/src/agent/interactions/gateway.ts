import { randomUUID } from 'node:crypto'
import {
  UserInteractionResponseSchema,
  type InteractionKind,
  type UserQuestion,
  type UserQuestionAnswer,
  type UserInteraction,
} from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../../events.js'
import type { Store } from '../../store/index.js'

interface PendingInteraction {
  runId: string
  toolCallId: string
  questions: UserQuestion[]
  settle: (answers: UserQuestionAnswer[]) => void
}

export interface UserQuestionRequest {
  sessionId: string
  runId: string
  toolCallId: string
  questions: UserQuestion[]
  kind?: InteractionKind
  emitter: RunEventEmitter
  signal: AbortSignal
}

export type InteractionResponse =
  { accepted: false } | { accepted: true; recovered: UserInteraction | null }

/** 结构化用户交互网关：持久化请求；进程内 Promise 仅负责当前运行实例。 */
export class InteractionGateway {
  private readonly pending = new Map<string, PendingInteraction>()

  constructor(private readonly store: Store) {}

  requestQuestions(input: UserQuestionRequest): Promise<UserQuestionAnswer[]> {
    const interactionId = randomUUID()
    this.store.transaction(() => {
      this.store.interactions.create({
        id: interactionId,
        sessionId: input.sessionId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        kind: input.kind ?? 'user_question',
        questions: input.questions,
      })
      this.store.runs.setIntermediateStatus(input.runId, 'awaiting_user_input')
      this.store.toolCalls.markStatus(input.toolCallId, 'awaiting_user_input')
    })
    return new Promise<UserQuestionAnswer[]>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(interactionId)
        this.store.interactions.removePending(interactionId)
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }
      if (input.signal.aborted) {
        onAbort()
        return
      }
      input.signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(interactionId, {
        runId: input.runId,
        toolCallId: input.toolCallId,
        questions: input.questions,
        settle: (answers) => {
          input.signal.removeEventListener('abort', onAbort)
          this.pending.delete(interactionId)
          this.store.runs.setIntermediateStatus(input.runId, 'running')
          this.store.toolCalls.markStatus(input.toolCallId, 'running')
          input.emitter.next({
            type: 'interaction.resolved',
            interactionId,
            toolCallId: input.toolCallId,
            answers,
          })
          resolve(answers)
        },
      })
      input.emitter.next({
        type: 'interaction.required',
        interactionId,
        toolCallId: input.toolCallId,
        sessionId: input.sessionId,
        kind: input.kind ?? 'user_question',
        questions: input.questions,
      })
    })
  }

  respond(
    interactionId: string,
    answers: UserQuestionAnswer[],
  ): InteractionResponse {
    const stored = this.store.interactions.get(interactionId)
    if (
      !stored ||
      stored.status !== 'pending' ||
      !validAnswers(stored.questions, answers)
    ) {
      return { accepted: false }
    }
    const entry = this.pending.get(interactionId)
    if (entry) {
      this.store.interactions.resolve(interactionId, answers)
      entry.settle(answers)
      return { accepted: true, recovered: null }
    }
    return { accepted: true, recovered: { ...stored, answers } }
  }

  listPending(): UserInteraction[] {
    return this.store.interactions.listPending()
  }

  hasPendingRun(runId: string): boolean {
    return [...this.pending.values()].some((entry) => entry.runId === runId)
  }
}

function validAnswers(
  questions: UserQuestion[],
  answers: UserQuestionAnswer[],
): boolean {
  const parsed = UserInteractionResponseSchema.shape.answers.safeParse(answers)
  if (!parsed.success) return false
  const byId = new Map(questions.map((question) => [question.id, question]))
  const seen = new Set<string>()
  for (const answer of parsed.data) {
    const question = byId.get(answer.questionId)
    if (!question || seen.has(answer.questionId)) return false
    seen.add(answer.questionId)
    if (!question.multiSelect && answer.selectedOptionIds.length > 1)
      return false
    const allowed = new Set(question.options.map((option) => option.id))
    if (answer.selectedOptionIds.some((id) => !allowed.has(id))) return false
  }
  return true
}
