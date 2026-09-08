import {
  type ModelMessage,
  type ModelTurn,
  type ToolRegistry,
} from '@reflexion-os-studio/agent-core'
import type { Message, Run } from '@reflexion-os-studio/contracts'
import { RunEventEmitter } from '../events.js'
import { streamChatCompletion } from '../provider.js'
import type { Store } from '../store/index.js'
import { compactInRun, type ProviderRuntimeConfig } from './context.js'
import { ChildLimitError } from './errors.js'
import { normalizeContent } from './resource-links.js'
import type { RunExecutionState, TurnDraft } from './run-state.js'

export interface ModelTurnInput {
  store: Store
  state: RunExecutionState
  run: Run
  provider: ProviderRuntimeConfig
  registry: ToolRegistry
  emitter: RunEventEmitter
  controller: AbortController
  /** 门面预建的首轮 assistant 消息（复用而非新建，保持 message.send 契约）。 */
  firstAssistantMessage: Message
  /** 子 Run 单次累计输出 token 预算；超出以 child_token_budget 稳定错误码中止。 */
  childTokenBudget?: number
}

export interface ModelTurnOutcome {
  /** 回传给循环的模型轮次结果。 */
  turn: ModelTurn
  /** 归一化（资源链接改写）后的正文，用作 Run 最终结果。 */
  finalContent: string
}

/**
 * 单个模型轮次：创建 assistant 草稿 → 上下文压缩 → 流式调用 →
 * 重置/重试事件 → 落终态 → 用量与 token 预算检查。
 */
export async function executeModelTurn(
  input: ModelTurnInput,
  messages: ModelMessage[],
  signal: AbortSignal,
): Promise<ModelTurnOutcome> {
  const { store, state, run, provider, registry, emitter } = input
  const reuseFirst = state.lastAssistantMessageId === null
  const assistantMessage = reuseFirst
    ? input.firstAssistantMessage
    : store.messages.create({
        sessionId: run.sessionId,
        runId: run.id,
        role: 'assistant',
        content: '',
        status: 'pending',
      })
  const draft: TurnDraft = {
    id: assistantMessage.id,
    content: '',
    reasoning: '',
  }
  state.turn = draft
  state.lastAssistantMessageId = assistantMessage.id
  emitter.next({ type: 'message.created', message: assistantMessage })

  let chunkSeq = 0
  let reasoningSeq = 0
  let streamingMarked = false
  const markStreaming = (): void => {
    if (streamingMarked || reuseFirst) return
    streamingMarked = true
    store.messages.markStreaming(draft.id)
  }

  const bounded = await compactInRun(messages, provider, signal)
  const result = await streamChatCompletion(
    {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: bounded,
      tools: registry.specs(),
      ...(provider.temperature !== undefined
        ? { temperature: provider.temperature }
        : {}),
      ...(provider.maxTokens !== undefined
        ? { maxTokens: provider.maxTokens }
        : {}),
      ...(provider.maxRetries !== undefined
        ? { maxRetries: provider.maxRetries }
        : {}),
      ...(provider.timeoutMs !== undefined
        ? { timeoutMs: provider.timeoutMs }
        : {}),
      onRetry: ({ attempt, maxRetries, reason, waitMs }) => {
        draft.content = ''
        draft.reasoning = ''
        chunkSeq = 0
        streamingMarked = false
        reasoningSeq = 0
        store.messages.resetPending(draft.id)
        store.runEvents.createRetrying({
          sessionId: run.sessionId,
          runId: run.id,
          attempt,
          maxRetries,
          reason,
        })
        emitter.next({
          type: 'run.retrying',
          attempt,
          maxRetries,
          reason,
          waitMs,
        })
        emitter.next({
          type: 'message.reset',
          messageId: draft.id,
        })
      },
      signal,
    },
    (delta) => {
      draft.content += delta
      markStreaming()
      emitter.next({
        type: 'message.delta',
        messageId: draft.id,
        chunkSeq: chunkSeq++,
        delta,
      })
    },
    (delta) => {
      draft.reasoning += delta
      markStreaming()
      emitter.next({
        type: 'message.reasoning_delta',
        messageId: draft.id,
        chunkSeq: reasoningSeq++,
        delta,
      })
    },
  )

  const session = store.sessions.get(run.sessionId)
  const normalized = session
    ? normalizeContent(result.content, session, store)
    : { content: result.content, parts: [] }
  store.messages.finalize(
    draft.id,
    normalized.content,
    'completed',
    result.reasoning,
    normalized.parts,
  )
  emitter.next({
    type: 'message.completed',
    messageId: draft.id,
    content: result.content,
    finishReason: result.finishReason,
    usage: result.usage,
    parts: normalized.parts,
  })
  if (result.usage) {
    store.runs.addUsage(run.id, result.usage)
  }
  state.turn = null
  // 子 Run token 预算：累计输出超限以稳定错误码中止(而非父取消)。
  // 放在 turn 置空之后，避免把已完成轮次误标为 failed。
  if (input.childTokenBudget != null) {
    const current = store.runs.get(run.id)
    const completion = current?.usage?.completionTokens ?? 0
    if (completion > input.childTokenBudget) {
      const limit = new ChildLimitError(
        'child_token_budget',
        `子 Run 输出 token 超过预算 ${input.childTokenBudget}`,
      )
      input.controller.abort(limit)
      throw new DOMException('child token budget exceeded', 'AbortError')
    }
  }
  return {
    turn: {
      content: result.content,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
      usage: result.usage,
    },
    finalContent: normalized.content,
  }
}
