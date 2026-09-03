import {
  runAgentLoop,
  type AgentLoopOutcome,
  type ModelMessage,
  type ToolRegistry,
  type ToolResult,
} from '@reflexion-os-studio/agent-core'
import {
  JsonValueSchema,
  type AgentSettings,
  type JsonValue,
  type Message,
  type Run,
} from '@reflexion-os-studio/contracts'
import { DEFAULT_MAX_TURNS } from '@reflexion-os-studio/agent-core'
import { RunEventEmitter } from '../events.js'
import { normalizeContent } from '../resources/resource-link-normalizer.js'
import { ProviderError, streamChatCompletion } from '../provider.js'
import type { Store } from '../store/index.js'
import { compactInRun, type ProviderRuntimeConfig } from './context.js'
import type { MemoryService } from './memory/service.js'
import type { ApprovalGateway, PermissionGate } from './permissions.js'
import {
  buildOnceGrant,
  buildSessionGrant,
  summarizeArgs,
} from './permissions.js'
import { capToolResultForModel, parseToolResultPayload } from './toolResults.js'

interface RunStreamInput {
  run: Run
  provider: ProviderRuntimeConfig
  /** Run 启动时构建会话历史（可能触发一次压缩摘要调用）。 */
  buildHistory: (signal: AbortSignal) => Promise<ModelMessage[]>
  registry: ToolRegistry
  workspaceRoot: string | null
  /** 权限闸门：automatic / ask / denied（workspace 或 read-only Profile）。 */
  gate: PermissionGate
  approvals: ApprovalGateway
  /** 本轮运行使用的 Agent 全局设置快照。 */
  settings: AgentSettings
  /** A2 Memory 写侧管线；null 表示禁用（不影响主流程）。 */
  memory: MemoryService | null
  controller: AbortController
  emitter: RunEventEmitter
  /** 门面预建的首轮 assistant 消息（保持 message.send 返回 messageId 的契约）。 */
  firstAssistantMessage: Message
}

/** 未落终态的模型轮次草稿：取消/失败时把已累积内容一并收尾。 */
interface TurnDraft {
  id: string
  content: string
  reasoning: string
}

interface RunExecutionState {
  /** 流式中断/失败时未落终态的当前轮次草稿。 */
  turn: TurnDraft | null
  /** 进行中未落终态的工具调用行（同轮并行时可能多个）。 */
  toolCallRowIds: Set<string>
  /** 最近一条 assistant 消息（工具调用行的关联消息）。 */
  lastAssistantMessageId: string | null
}

/**
 * 单次 Run 的执行编排：驱动 agent-core 循环，负责持久化、事件与取消语义。
 * 每个模型轮次落一条 assistant 消息，工具调用落 tool_calls 并发出对应事件；
 * 任务以"模型不再请求工具"为完成标志，达到轮次上限则如实失败。
 */
export class RunRunner {
  constructor(private readonly store: Store) {}

  private finishPlan(
    run: Run,
    emitter: RunEventEmitter,
    status: 'failed' | 'cancelled',
    summary: string,
  ): void {
    // Plan linkage may be created by update_plan during this Run; re-read by runId.
    const currentRun = this.store.runs.get(run.id)
    const planId = currentRun?.planId ?? run.planId
    if (!planId) return
    try {
      const linked = this.store.plans.get(planId)
      if (
        !linked ||
        linked.sessionId !== run.sessionId ||
        linked.status !== 'active'
      )
        return
      const plan =
        status === 'failed'
          ? this.store.plans.fail(planId, summary)
          : this.store.plans.cancel(planId, summary)
      // Plan 事件使用当前 Run 的 emitter，在调用点单独发出。
      emitter.next({ type: 'plan.updated', plan })
    } catch {
      // 计划收敛失败不应掩盖 Run 的真实终态。
    }
  }

  /** 工具调用行收尾的统一出口：清 in-flight 记录 → 落库 → 事件。 */
  private finalizeToolCall(
    state: RunExecutionState,
    emitter: RunEventEmitter,
    rowId: string,
    status: 'completed' | 'failed' | 'cancelled',
    errorCode: string | null,
    result?: JsonValue,
  ): void {
    state.toolCallRowIds.delete(rowId)
    if (status === 'completed') {
      this.store.toolCalls.finalize(rowId, 'completed', result)
    } else {
      this.store.toolCalls.finalize(
        rowId,
        status,
        undefined,
        errorCode ?? undefined,
      )
    }
    emitter.next({
      type: 'tool.completed',
      toolCallId: rowId,
      status,
      errorCode,
    })
  }

  async execute(input: RunStreamInput): Promise<void> {
    const { run, controller, emitter, registry } = input
    const maxTurns = input.settings.maxTurns ?? DEFAULT_MAX_TURNS
    const state: RunExecutionState = {
      turn: null,
      toolCallRowIds: new Set(),
      lastAssistantMessageId: null,
    }

    const cancelInFlightToolCalls = (): void => {
      for (const rowId of state.toolCallRowIds) {
        this.finalizeToolCall(state, emitter, rowId, 'cancelled', null)
      }
      state.toolCallRowIds.clear()
    }

    const finalizePendingTurn = (status: 'interrupted' | 'failed'): void => {
      if (!state.turn) return
      const draft = state.turn
      state.turn = null
      this.store.messages.finalize(
        draft.id,
        draft.content,
        status,
        draft.reasoning,
      )
    }

    try {
      const history = await input.buildHistory(controller.signal)
      const outcome: AgentLoopOutcome = await runAgentLoop({
        history,
        signal: controller.signal,
        maxTurns,
        reflectionThreshold: input.settings.reflectionThreshold ?? undefined,
        callModel: async (messages, signal) => {
          const reuseFirst = state.lastAssistantMessageId === null
          const assistantMessage = reuseFirst
            ? input.firstAssistantMessage
            : this.store.messages.create({
                sessionId: input.run.sessionId,
                runId: input.run.id,
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
            this.store.messages.markStreaming(draft.id)
          }

          const bounded = await compactInRun(messages, input.provider, signal)
          const result = await streamChatCompletion(
            {
              baseUrl: input.provider.baseUrl,
              apiKey: input.provider.apiKey,
              model: input.provider.model,
              messages: bounded,
              tools: registry.specs(),
              ...(input.provider.temperature !== undefined
                ? { temperature: input.provider.temperature }
                : {}),
              ...(input.provider.maxTokens !== undefined
                ? { maxTokens: input.provider.maxTokens }
                : {}),
              ...(input.provider.maxRetries !== undefined
                ? { maxRetries: input.provider.maxRetries }
                : {}),
              ...(input.provider.timeoutMs !== undefined
                ? { timeoutMs: input.provider.timeoutMs }
                : {}),
              onRetry: ({ attempt, maxRetries, reason }) => {
                emitter.next({
                  type: 'run.retrying',
                  attempt,
                  maxRetries,
                  reason,
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

          const session = this.store.sessions.get(run.sessionId)
          const normalized = session
            ? normalizeContent(result.content, session, this.store)
            : { content: result.content, parts: [] }
          this.store.messages.finalize(
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
            this.store.runs.addUsage(run.id, result.usage)
          }
          state.turn = null
          return {
            content: result.content,
            reasoning: result.reasoning,
            toolCalls: result.toolCalls,
            finishReason: result.finishReason,
            usage: result.usage,
          }
        },
        executeTool: async (request, signal) => {
          const args = parseToolArgs(request.arguments)
          const decision = input.gate.decisionFor(request.name)

          // 策略拒绝：落一条失败的调用记录，让模型知道原因而不是静默失败。
          if (decision === 'denied') {
            const row = this.store.toolCalls.create({
              runId: run.id,
              messageId: state.lastAssistantMessageId,
              toolName: request.name,
              args,
              status: 'failed',
            })
            emitter.next({
              type: 'tool.requested',
              toolCallId: row.id,
              toolName: request.name,
              args,
            })
            this.finalizeToolCall(
              state,
              emitter,
              row.id,
              'failed',
              'permission_denied',
            )
            return {
              content: `权限策略拒绝了 ${request.name}（当前 Profile 不允许该操作）`,
              isError: true,
              code: 'permission_denied',
            }
          }

          // 会话级授权同时覆盖内置操作与动态工具名（MCP 的 serverId/toolName），
          // 因此在 ask 判定处不再按 isToolOperation 过滤，统一走 hasSessionGrant。
          const askNeeded =
            decision === 'ask' &&
            !input.approvals.hasSessionGrant(request.name, {
              sessionId: run.sessionId,
              workspaceRoot: input.workspaceRoot,
            })
          const row = this.store.toolCalls.create({
            runId: run.id,
            messageId: state.lastAssistantMessageId,
            toolName: request.name,
            args,
            status: askNeeded ? 'awaiting_approval' : 'running',
          })
          state.toolCallRowIds.add(row.id)
          emitter.next({
            type: 'tool.requested',
            toolCallId: row.id,
            toolName: request.name,
            args,
          })

          // 授权引用：ask 批准后以本次调用为 once 凭据；会话级授权用稳定引用。
          let grant: string | undefined
          if (askNeeded) {
            this.store.runs.setIntermediateStatus(run.id, 'awaiting_approval')
            let verdict: 'approved' | 'denied'
            try {
              verdict = await input.approvals.request({
                toolCallId: row.id,
                emitter,
                operation: request.name,
                summary: summarizeArgs(request.name, args),
                signal,
                context: {
                  sessionId: run.sessionId,
                  workspaceRoot: input.workspaceRoot,
                },
              })
            } finally {
              // 并行工具轮次:还有其它调用在等审批时保持 awaiting_approval,
              // 否则才回置 running,避免 Run 状态错报。
              if (!input.approvals.hasPendingRun(run.id)) {
                this.store.runs.setIntermediateStatus(run.id, 'running')
              }
            }
            if (verdict === 'denied') {
              this.finalizeToolCall(
                state,
                emitter,
                row.id,
                'failed',
                'permission_denied',
              )
              return {
                content: `用户拒绝了本次 ${request.name} 操作`,
                isError: true,
                code: 'permission_denied',
              }
            }
            grant = buildOnceGrant({
              grantId: row.id,
              requestId: row.id,
              sessionId: run.sessionId,
              workspaceRoot: input.workspaceRoot,
              operation: request.name,
            })
            this.store.toolCalls.markStatus(row.id, 'running', row.id)
          } else if (decision === 'ask') {
            grant = buildSessionGrant({
              grantId: `session:${request.name}`,
              requestId: row.id,
              sessionId: run.sessionId,
              workspaceRoot: input.workspaceRoot,
              operation: request.name,
            })
            this.store.toolCalls.markStatus(row.id, 'running', grant)
          }

          const result = await registry.call(request, signal, grant)
          state.toolCallRowIds.delete(row.id)
          // 持久化保存完整结果（审计不做盲区），回填模型前只取截断副本。
          const modelResult: ToolResult = {
            ...result,
            content: capToolResultForModel(result.content),
          }
          if (result.isError) {
            const errorCode = result.code ?? 'tool_error'
            this.finalizeToolCall(state, emitter, row.id, 'failed', errorCode)
          } else {
            this.finalizeToolCall(
              state,
              emitter,
              row.id,
              'completed',
              null,
              parseToolResultPayload(result.content),
            )
          }
          return modelResult
        },
      })

      if (outcome.status === 'completed') {
        this.store.runs.finalize(run.id, 'completed')
        emitter.next({ type: 'run.completed' })
        // A2 Memory：Run 成功后异步提取记忆（fire-and-forget，失败只写 stderr）。
        if (input.memory) {
          void input.memory
            .processRun({ run, provider: input.provider, emitter })
            .catch((error: unknown) => {
              process.stderr.write(
                `[runtime] memory extraction failed: ${String(error)}\n`,
              )
            })
        }
        return
      }
      // 达到轮次上限：任务未完成，如实失败而不是装作结束。
      this.store.runs.finalize(run.id, 'failed', 'max_turns')
      this.finishPlan(run, emitter, 'failed', 'Run 达到轮次上限')
      emitter.next({
        type: 'run.failed',
        error: {
          code: 'internal',
          message: `任务在 ${maxTurns} 轮内未完成，已停止执行`,
        },
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        cancelInFlightToolCalls()
        finalizePendingTurn('interrupted')
        this.store.runs.finalize(run.id, 'cancelled')
        this.finishPlan(run, emitter, 'cancelled', 'Run 已被取消')
        emitter.next({ type: 'run.cancelled' })
        return
      }

      const code = error instanceof ProviderError ? error.code : 'internal'
      const message = error instanceof Error ? error.message : 'unknown failure'
      // Provider/工具循环异常只经事件与 stderr 暴露，不进 stdout 协议通道。
      process.stderr.write(`[runtime] run failed (${code}): ${message}\n`)
      cancelInFlightToolCalls()
      finalizePendingTurn('failed')
      this.store.runs.finalize(run.id, 'failed', code)
      this.finishPlan(run, emitter, 'failed', message)
      emitter.next({ type: 'run.failed', error: { code, message } })
    }
  }
}

function parseToolArgs(arguments_: string): JsonValue {
  try {
    const parsed: unknown =
      arguments_.trim() === '' ? {} : JSON.parse(arguments_)
    const result = JsonValueSchema.safeParse(parsed)
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}
