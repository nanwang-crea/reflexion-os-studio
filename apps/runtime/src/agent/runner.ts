import {
  DEFAULT_MAX_TURNS,
  boundMessagesForModel,
  runAgentLoop,
  type AgentLoopOutcome,
  type ModelMessage,
  type ModelTurn,
  type ToolRegistry,
  type ToolResult,
} from '@reflexion-os-studio/agent-core'
import {
  JsonValueSchema,
  type JsonValue,
  type Message,
  type Run,
} from '@reflexion-os-studio/contracts'
import { RunEventEmitter } from '../events.js'
import { ProviderError, streamChatCompletion } from '../provider.js'
import type { Store } from '../store/index.js'
import { CONTEXT_TOKEN_BUDGET, type ProviderRuntimeConfig } from './context.js'
import type { MemoryService } from './memory/service.js'
import type { ApprovalGateway, PermissionGate } from './permissions.js'
import { isToolOperation } from './permissions.js'
import { capToolResultForModel } from './toolResults.js'

interface RunStreamInput {
  run: Run
  provider: ProviderRuntimeConfig
  /** Run 启动时构建会话历史（可能触发一次压缩摘要调用）。 */
  buildHistory: (signal: AbortSignal) => Promise<ModelMessage[]>
  registry: ToolRegistry
  /** 权限闸门：automatic / ask / denied（workspace 或 read-only Profile）。 */
  gate: PermissionGate
  approvals: ApprovalGateway
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

  async execute(input: RunStreamInput): Promise<void> {
    const { run, controller, emitter, registry } = input
    const state: RunExecutionState = {
      turn: null,
      toolCallRowIds: new Set(),
      lastAssistantMessageId: null,
    }

    const cancelInFlightToolCalls = (): void => {
      for (const rowId of state.toolCallRowIds) {
        this.store.toolCalls.finalize(rowId, 'cancelled')
        emitter.next({
          type: 'tool.completed',
          toolCallId: rowId,
          status: 'cancelled',
          errorCode: null,
        })
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
        maxTurns: DEFAULT_MAX_TURNS,
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

          const bounded = boundMessagesForModel(messages, CONTEXT_TOKEN_BUDGET)
          const result = await streamChatCompletion(
            {
              baseUrl: input.provider.baseUrl,
              apiKey: input.provider.apiKey,
              model: input.provider.model,
              messages: bounded,
              tools: registry.specs(),
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

          this.store.messages.finalize(
            draft.id,
            result.content,
            'completed',
            result.reasoning,
          )
          emitter.next({
            type: 'message.completed',
            messageId: draft.id,
            content: result.content,
            finishReason: result.finishReason,
            usage: result.usage,
          })
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
            this.store.toolCalls.finalize(
              row.id,
              'failed',
              undefined,
              'permission_denied',
            )
            emitter.next({
              type: 'tool.completed',
              toolCallId: row.id,
              status: 'failed',
              errorCode: 'permission_denied',
            })
            return {
              content: `权限策略拒绝了 ${request.name}（当前 Profile 不允许该操作）`,
              isError: true,
              code: 'permission_denied',
            }
          }

          const askNeeded =
            decision === 'ask' &&
            !(
              isToolOperation(request.name) &&
              input.approvals.hasSessionGrant(request.name)
            )
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
                operation: request.name as Parameters<
                  ApprovalGateway['request']
                >[0]['operation'],
                summary: summarizeArgs(request.name, args),
                signal,
              })
            } finally {
              // 并行工具轮次:还有其它调用在等审批时保持 awaiting_approval,
              // 否则才回置 running,避免 Run 状态错报。
              if (!input.approvals.hasPendingRun(run.id)) {
                this.store.runs.setIntermediateStatus(run.id, 'running')
              }
            }
            if (verdict === 'denied') {
              state.toolCallRowIds.delete(row.id)
              this.store.toolCalls.finalize(
                row.id,
                'failed',
                undefined,
                'permission_denied',
              )
              emitter.next({
                type: 'tool.completed',
                toolCallId: row.id,
                status: 'failed',
                errorCode: 'permission_denied',
              })
              return {
                content: `用户拒绝了本次 ${request.name} 操作`,
                isError: true,
                code: 'permission_denied',
              }
            }
            grant = row.id
            this.store.toolCalls.markStatus(row.id, 'running', row.id)
          } else if (decision === 'ask') {
            grant = `session:${request.name}`
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
            this.store.toolCalls.finalize(
              row.id,
              'failed',
              undefined,
              errorCode,
            )
            emitter.next({
              type: 'tool.completed',
              toolCallId: row.id,
              status: 'failed',
              errorCode,
            })
          } else {
            this.store.toolCalls.finalize(
              row.id,
              'completed',
              parseToolResultPayload(result.content),
            )
            emitter.next({
              type: 'tool.completed',
              toolCallId: row.id,
              status: 'completed',
              errorCode: null,
            })
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
      emitter.next({
        type: 'run.failed',
        error: {
          code: 'internal',
          message: `任务在 ${DEFAULT_MAX_TURNS} 轮内未完成，已停止执行`,
        },
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        cancelInFlightToolCalls()
        finalizePendingTurn('interrupted')
        this.store.runs.finalize(run.id, 'cancelled')
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

/** 审批卡摘要：文件操作显示路径，move 显示 from→to，shell 显示命令，其余回退到参数 JSON。 */
function summarizeArgs(toolName: string, args: JsonValue): string {
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined
  if (record !== undefined) {
    if (typeof record.path === 'string') return `${toolName}: ${record.path}`
    if (typeof record.from === 'string' && typeof record.to === 'string') {
      return `${toolName}: ${record.from} → ${record.to}`
    }
    if (typeof record.command === 'string')
      return `${toolName}: ${record.command}`
  }
  return `${toolName}: ${JSON.stringify(args).slice(0, 200)}`
}

/** 工具结果落库：能解析为 JSON 则存结构，否则存原文。 */
function parseToolResultPayload(content: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(content)
    const result = JsonValueSchema.safeParse(parsed)
    return result.success ? result.data : content
  } catch {
    return content
  }
}
