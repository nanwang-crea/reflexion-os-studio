import {
  runAgentLoop,
  LoopGuard,
  ModelProtocolError,
  type AgentStopReason,
  type ModelMessage,
  type ToolRegistry,
} from '@reflexion-os-studio/agent-core'
import { DEFAULT_MAX_TURNS } from '@reflexion-os-studio/agent-core'
import type { AgentSettings, Run } from '@reflexion-os-studio/contracts'
import { RunEventEmitter } from '../events.js'
import { ProviderError } from '../provider.js'
import type { Store } from '../store/index.js'
import type { ProviderRuntimeConfig } from './context.js'
import { ChildLimitError } from './errors.js'
import { executeModelTurn } from './model-turn.js'
import type { ApprovalGateway, PermissionGate } from './permissions.js'
import { createRunExecutionState } from './run-state.js'
import { RunFinalizer, type RunTerminalDecision } from './run-finalizer.js'
import { executeToolCall } from './tool-executor.js'
import { executeToolBatch, type SchedulerDeps } from './tool-scheduler.js'

export interface RunStreamInput {
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
  /** Run 终态后的 Memory Job 通知（可选；worker 由 ChatAgent 注入）。 */
  onMemoryJob?: () => void
  controller: AbortController
  emitter: RunEventEmitter
  /** 门面预建的首轮 assistant 消息（保持 message.send 返回 messageId 的契约）。 */
  firstAssistantMessage: import('@reflexion-os-studio/contracts').Message
  onResult?: (content: string) => void
  onFailure?: (error: Error) => void
  /** 子 Run 被取消(父取消)时回调，用于把委派落为 cancelled；缺省不回调。 */
  onCancel?: () => void
  /** 子 Run 单次累计输出 token 预算；超出以 child_token_budget 稳定错误码中止。 */
  childTokenBudget?: number
}

/** 稳定停止原因的用户可见描述（run.failed 的 message；错误码本身随事件下发）。 */
function describeStop(reason: AgentStopReason, maxTurns: number): string {
  switch (reason) {
    case 'max_turns':
      return `任务在 ${maxTurns} 轮内未完成，已停止执行`
    case 'output_truncated':
      return '模型输出连续超长被截断，续写预算已用尽'
    case 'content_filtered':
      return '模型拒绝回答或内容被安全策略拦截'
    case 'no_progress':
      return '检测到重复无进展的执行循环，已停止'
    case 'provider_protocol':
      return 'Provider 返回了不符合协议的响应'
    case 'run_timeout':
      return 'Run 总时长超出限制，已停止执行'
    case 'run_token_budget':
      return 'Run 累计 token 超出预算，已停止执行'
    case 'tool_call_budget':
      return 'Run 工具调用次数超出预算，已停止执行'
  }
}

/** 最终结果 = 最后一个工具轮之后的连续文本片段拼接（length 续写为多片段）。 */
function joinFinalFragments(fragments: string[]): string {
  return fragments.join('\n\n')
}

/**
 * 单次 Run 的执行编排：驱动 agent-core 循环并构造终态决策；
 * 持久化收敛统一交给 RunFinalizer（唯一终态入口）。
 * 每个模型轮次落一条 assistant 消息，工具调用落 tool_calls 并发出对应事件；
 * 只有语义完整（stop 且无工具）的轮次才完成 Run，其余以稳定错误码失败。
 * 轮次持久化（model-turn.ts）与工具执行（tool-executor.ts）各自独立成模块。
 */
export class RunRunner {
  constructor(private readonly store: Store) {}

  async execute(input: RunStreamInput): Promise<void> {
    const { run, controller, emitter, registry } = input
    const maxTurns = input.settings.maxTurns ?? DEFAULT_MAX_TURNS
    const state = createRunExecutionState()
    const finalizer = new RunFinalizer(this.store)
    const guard = new LoopGuard()
    const budgets = {
      maxRunTimeoutSec: input.settings.maxRunTimeoutSec ?? 900,
      maxRunTotalTokens: input.settings.maxRunTotalTokens ?? 120_000,
      maxToolCalls: input.settings.maxToolCalls ?? 64,
      maxContinuationTurns: input.settings.maxContinuationTurns ?? 2,
    }
    const runStartedAt = Date.now()
    let finalFragments: string[] = []
    let toolCallsUsed = 0
    let modelTurnsUsed = 0

    /** 单工具执行（供调度器与预算分支共用）：权限上下文完整。 */
    const executeOneGuarded = (
      request: import('@reflexion-os-studio/agent-core').ToolCallRequest,
      signal: AbortSignal,
    ): Promise<import('@reflexion-os-studio/agent-core').ToolResult> =>
      executeToolCall(
        {
          store: this.store,
          state,
          run,
          gate: input.gate,
          approvals: input.approvals,
          workspaceRoot: input.workspaceRoot,
          registry,
          emitter,
        },
        request,
        signal,
      )

    const finalize = (decision: RunTerminalDecision): void => {
      finalizer.finalize(
        {
          run,
          state,
          emitter,
          onResult: input.onResult,
          onFailure: input.onFailure,
          onCancel: input.onCancel,
        },
        decision,
      )
      if (decision.status === 'completed' && decision.enqueueMemoryJob) {
        input.onMemoryJob?.()
      }
      // 诊断指标（§17.1）：stopReason/轮次/工具数/耗时，单行 stderr。
      process.stderr.write(
        `[metrics] run:${run.id.slice(0, 8)} stopReason:${decision.errorCode ?? decision.status} modelCallCount:${modelTurnsUsed} toolCallCount:${toolCallsUsed} runElapsedMs:${Date.now() - runStartedAt}\n`,
      )
    }

    try {
      // Run 总时限：到点中止（ChildLimitError 语义区分取消与预算失败）。
      const timeoutHandle = setTimeout(
        () =>
          controller.abort(
            new ChildLimitError(
              'run_timeout',
              `Run 总时长超过 ${budgets.maxRunTimeoutSec}s 上限`,
            ),
          ),
        budgets.maxRunTimeoutSec * 1000,
      )
      try {
        const history = await input.buildHistory(controller.signal)
        const outcome = await runAgentLoop({
          history,
          signal: controller.signal,
          maxTurns,
          maxContinuationTurns: budgets.maxContinuationTurns,
          reflectionThreshold: input.settings.reflectionThreshold ?? undefined,
          callModel: async (messages, signal) => {
            modelTurnsUsed += 1
            // Run 累计 token 预算在 model-turn 内检查（usage 累计后）。
            const result = await executeModelTurn(
              {
                store: this.store,
                state,
                run,
                provider: input.provider,
                registry,
                emitter,
                controller,
                firstAssistantMessage: input.firstAssistantMessage,
                childTokenBudget: input.childTokenBudget,
                runTotalTokenBudget: budgets.maxRunTotalTokens,
              },
              messages,
              signal,
            )
            // 最终结果片段：工具轮后重置，无工具轮（含 length 续写片段）追加。
            if (result.turn.toolCalls.length === 0) {
              finalFragments.push(result.finalContent)
            } else {
              finalFragments = []
            }
            return result.turn
          },
          executeToolBatch: (requests, signal) => {
            // 工具调用次数预算：超限的请求折叠为稳定错误结果（模型自纠一次；
            // 预算失败由 Finalizer 记 run_token/tool_call_budget）。
            if (toolCallsUsed + requests.length > budgets.maxToolCalls) {
              const remaining = Math.max(
                0,
                budgets.maxToolCalls - toolCallsUsed,
              )
              process.stderr.write(
                `[runtime] tool call budget exhausted (${toolCallsUsed}/${budgets.maxToolCalls})\n`,
              )
              return Promise.all(
                requests.map((request, index) =>
                  index < remaining
                    ? executeOneGuarded(request, signal)
                    : Promise.resolve({
                        content: `已达到 Run 工具调用次数上限 ${budgets.maxToolCalls}，本次调用未执行。`,
                        isError: true,
                        code: 'tool_call_budget',
                      }),
                ),
              )
            }
            toolCallsUsed += requests.length
            const deps: SchedulerDeps = {
              store: this.store,
              state,
              run,
              gate: input.gate,
              approvals: input.approvals,
              workspaceRoot: input.workspaceRoot,
              registry,
              emitter,
              guard,
              executeOne: executeOneGuarded,
            }
            return executeToolBatch(deps, requests, signal)
          },
        })

        if (outcome.status === 'completed') {
          finalize({
            status: 'completed',
            errorCode: null,
            errorMessage: null,
            pendingMessage: null,
            enqueueMemoryJob: true,
            resultContent: joinFinalFragments(finalFragments),
          })
          return
        }
        const message = describeStop(outcome.reason, maxTurns)
        process.stderr.write(
          `[runtime] run stopped (${outcome.reason}): ${message}\n`,
        )
        finalize({
          status: 'failed',
          errorCode: outcome.reason,
          errorMessage: message,
          pendingMessage: null,
          enqueueMemoryJob: false,
        })
      } finally {
        clearTimeout(timeoutHandle)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const reason = controller.signal.reason
        if (reason instanceof ChildLimitError) {
          finalize({
            status: 'failed',
            errorCode: reason.code,
            errorMessage: reason.message,
            pendingMessage: null,
            enqueueMemoryJob: false,
          })
          return
        }
        finalize({
          status: 'cancelled',
          errorCode: null,
          errorMessage: null,
          pendingMessage: null,
          enqueueMemoryJob: false,
        })
        return
      }
      if (error instanceof ChildLimitError) {
        // 调度器直接抛出的预算/无进展收敛（如 Loop Guard no_progress）。
        finalize({
          status: 'failed',
          errorCode: error.code,
          errorMessage: error.message,
          pendingMessage: null,
          enqueueMemoryJob: false,
        })
        return
      }

      const code =
        error instanceof ProviderError
          ? error.code
          : error instanceof ModelProtocolError
            ? 'provider_protocol'
            : 'internal'
      const message = error instanceof Error ? error.message : 'unknown failure'
      // Provider/工具循环异常只经事件与 stderr 暴露，不进 stdout 协议通道。
      process.stderr.write(`[runtime] run failed (${code}): ${message}\n`)
      finalize({
        status: 'failed',
        errorCode: code,
        errorMessage: message,
        pendingMessage: null,
        enqueueMemoryJob: false,
      })
    }
  }
}
