import {
  runAgentLoop,
  type AgentLoopOutcome,
  type ModelMessage,
} from '@reflexion-os-studio/agent-core'
import { DEFAULT_MAX_TURNS } from '@reflexion-os-studio/agent-core'
import type { AgentSettings, Run } from '@reflexion-os-studio/contracts'
import { RunEventEmitter } from '../events.js'
import { ProviderError } from '../provider.js'
import type { Store } from '../store/index.js'
import type { ProviderRuntimeConfig } from './context.js'
import { ChildLimitError } from './errors.js'
import { executeModelTurn } from './model-turn.js'
import type { MemoryService } from './memory/service.js'
import type { ApprovalGateway, PermissionGate } from './permissions.js'
import { createRunExecutionState, finalizeToolCall } from './run-state.js'
import { executeToolCall } from './tool-executor.js'

export interface RunStreamInput {
  run: Run
  provider: ProviderRuntimeConfig
  /** Run 启动时构建会话历史（可能触发一次压缩摘要调用）。 */
  buildHistory: (signal: AbortSignal) => Promise<ModelMessage[]>
  registry: import('@reflexion-os-studio/agent-core').ToolRegistry
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
  firstAssistantMessage: import('@reflexion-os-studio/contracts').Message
  onResult?: (content: string) => void
  onFailure?: (error: Error) => void
  /** 子 Run 被取消(父取消)时回调，用于把委派落为 cancelled；缺省不回调。 */
  onCancel?: () => void
  /** 子 Run 单次累计输出 token 预算；超出以 child_token_budget 稳定错误码中止。 */
  childTokenBudget?: number
}

/**
 * 单次 Run 的执行编排：驱动 agent-core 循环，负责持久化、事件与取消语义。
 * 每个模型轮次落一条 assistant 消息，工具调用落 tool_calls 并发出对应事件；
 * 任务以"模型不再请求工具"为完成标志，达到轮次上限则如实失败。
 * 轮次持久化（model-turn.ts）与工具执行（tool-executor.ts）各自独立成模块。
 */
export class RunRunner {
  constructor(private readonly store: Store) {}

  private finishPlan(
    run: Run,
    emitter: RunEventEmitter,
    status: 'failed' | 'cancelled',
    summary: string,
  ): void {
    // Plan linkage may be created by manage_plan during this Run; re-read by runId.
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

  async execute(input: RunStreamInput): Promise<void> {
    const { run, controller, emitter, registry } = input
    const maxTurns = input.settings.maxTurns ?? DEFAULT_MAX_TURNS
    const state = createRunExecutionState()
    let finalContent = ''

    const cancelInFlightToolCalls = (): void => {
      for (const rowId of state.toolCallRowIds) {
        finalizeToolCall(this.store, state, emitter, rowId, 'cancelled', null)
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
          const outcome = await executeModelTurn(
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
            },
            messages,
            signal,
          )
          finalContent = outcome.finalContent
          return outcome.turn
        },
        executeTool: (request, signal) =>
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
          ),
      })

      if (outcome.status === 'completed') {
        this.store.runs.finalize(run.id, 'completed')
        input.onResult?.(finalContent)
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
        const reason = controller.signal.reason
        if (reason instanceof ChildLimitError) {
          cancelInFlightToolCalls()
          finalizePendingTurn('failed')
          this.store.runs.finalize(run.id, 'failed', reason.code)
          this.finishPlan(run, emitter, 'failed', reason.message)
          input.onFailure?.(reason)
          this.store.runEvents.createFailed({
            sessionId: run.sessionId,
            runId: run.id,
            errorCode: reason.code,
            errorMessage: reason.message,
          })
          emitter.next({
            type: 'run.failed',
            error: { code: reason.code, message: reason.message },
          })

          return
        }
        cancelInFlightToolCalls()
        finalizePendingTurn('interrupted')
        this.store.runs.finalize(run.id, 'cancelled')
        this.finishPlan(run, emitter, 'cancelled', 'Run 已被取消')
        input.onCancel?.()
        emitter.next({ type: 'run.cancelled' })
        return
      }

      const code = error instanceof ProviderError ? error.code : 'internal'
      const message = error instanceof Error ? error.message : 'unknown failure'
      input.onFailure?.(error instanceof Error ? error : new Error(message))
      // Provider/工具循环异常只经事件与 stderr 暴露，不进 stdout 协议通道。
      process.stderr.write(`[runtime] run failed (${code}): ${message}\n`)
      cancelInFlightToolCalls()
      finalizePendingTurn('failed')
      this.store.runs.finalize(run.id, 'failed', code)
      this.finishPlan(run, emitter, 'failed', message)
      this.store.runEvents.createFailed({
        sessionId: run.sessionId,
        runId: run.id,
        errorCode: code,
        errorMessage: message,
      })
      emitter.next({ type: 'run.failed', error: { code, message } })
    }
  }
}
