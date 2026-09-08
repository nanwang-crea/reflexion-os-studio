import type { ContentPart, Plan, Run } from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../events.js'
import type { Store } from '../store/index.js'
import type { ProviderRuntimeConfig } from './context.js'
import type { MemoryService } from './memory/service.js'
import type { RunExecutionState } from './run-state.js'

/** 待收尾的 assistant 轮次草稿：内容与 reasoning 随终态一并落库。 */
export interface PendingMessageFinalization {
  messageId: string
  content: string
  reasoning: string
  parts?: ContentPart[]
}

/** Run 终态决策：唯一终态入口的输入；回调与事件由 Finalizer 统一收敛。 */
export interface RunTerminalDecision {
  status: 'completed' | 'failed' | 'cancelled'
  errorCode: string | null
  errorMessage: string | null
  /** 失败/取消时可选地把模型可见内容随草稿收尾；completed 无待收尾草稿。 */
  pendingMessage: PendingMessageFinalization | null
  /** 关联活动计划的处置：completed 保留；失败置 failed；取消置 cancelled。 */
  planDisposition: 'keep' | 'fail' | 'cancel'
  /** 仅 completed Run 触发 Memory 提取。 */
  enqueueMemoryJob: boolean
  /** completed 时回传给 onResult 的最终结果文本。 */
  resultContent?: string
}

export interface FinalizeContext {
  run: Run
  state: RunExecutionState
  emitter: RunEventEmitter
  /** A2 Memory 写侧管线；null 表示禁用。 */
  memory: MemoryService | null
  /** 本次 Run 的 Provider 配置（Memory 提取用）。 */
  provider: ProviderRuntimeConfig
  onResult?: (content: string) => void
  onFailure?: (error: Error) => void
  onCancel?: () => void
}

interface CommittedOutcome {
  cancelledToolCallIds: string[]
  updatedPlan: Plan | null
}

/**
 * Atomic Run Finalizer：全部 Run 终态的唯一生产入口。
 * 一个 SQLite 事务内完成 pending 消息收尾、未终态 ToolCall 取消、
 * 计划收敛、Run 终态与失败事件写入；事务提交后按序发出事件并执行回调。
 * 回调最多执行一次；通知器抛错不吞回调，避免子 Run Promise 永久 pending。
 */
export class RunFinalizer {
  constructor(private readonly store: Store) {}

  finalize(context: FinalizeContext, decision: RunTerminalDecision): void {
    const { run, state, emitter } = context
    // 提交前对内存态做快照：事务回滚不丢失已流式累积的内容，
    // 受控重试可以复用同一快照；提交成功后才清理内存态。
    const snapshot = {
      turn: state.turn,
      inFlightToolCallIds: [...state.toolCallRowIds],
    }
    let committed: CommittedOutcome
    try {
      committed = this.commitTerminalState(run, snapshot, decision)
    } catch (firstError) {
      // 事务失败：Run 保持非终态，记录后受控重试一次。
      process.stderr.write(
        `[runtime] run finalization failed (${run.id}): ${describeError(firstError)}; retrying once\n`,
      )
      committed = this.commitTerminalState(run, snapshot, decision)
    }
    // 提交成功：清理内存态。
    state.turn = null
    state.toolCallRowIds.clear()

    // 事务已提交：按序发出终态事件（通知器抛错只记 stderr，不阻断回调）。
    try {
      for (const toolCallId of committed.cancelledToolCallIds) {
        emitter.next({
          type: 'tool.completed',
          toolCallId,
          status: 'cancelled',
          errorCode: null,
        })
      }
      if (committed.updatedPlan !== null) {
        emitter.next({ type: 'plan.updated', plan: committed.updatedPlan })
      }
      if (decision.status === 'completed') {
        emitter.next({ type: 'run.completed' })
      } else if (decision.status === 'cancelled') {
        emitter.next({ type: 'run.cancelled' })
      } else {
        emitter.next({
          type: 'run.failed',
          error: {
            code: decision.errorCode ?? 'internal',
            message: decision.errorMessage ?? 'Run failed',
          },
        })
      }
    } catch (error) {
      process.stderr.write(
        `[runtime] terminal event emission failed (${run.id}): ${describeError(error)}\n`,
      )
    }

    // Memory 提取仅对成功 Run 触发；失败/取消不进入提取管线。
    if (
      decision.status === 'completed' &&
      decision.enqueueMemoryJob &&
      context.memory
    ) {
      void context.memory
        .processRun({ run, provider: context.provider, emitter })
        .catch((error: unknown) => {
          process.stderr.write(
            `[runtime] memory extraction failed: ${describeError(error)}\n`,
          )
        })
    }

    // settled 语义：回调最多执行一次且必须执行（异常也不跳过其它收尾）。
    if (decision.status === 'completed') {
      context.onResult?.(decision.resultContent ?? '')
    } else if (decision.status === 'cancelled') {
      context.onCancel?.()
    } else {
      context.onFailure?.(
        new Error(
          decision.errorMessage ??
            `run failed: ${decision.errorCode ?? 'internal'}`,
        ),
      )
    }
  }

  /**
   * 单事务写入全部终态行。任一步失败整体回滚，Run 保持非终态。
   * 返回事务后发事件所需的数据（已取消 ToolCall、收敛后的 Plan）。
   * 只读快照，不改内存态；重试可安全复用。
   */
  private commitTerminalState(
    run: Run,
    snapshot: {
      turn: RunExecutionState['turn']
      inFlightToolCallIds: string[]
    },
    decision: RunTerminalDecision,
  ): CommittedOutcome {
    return this.store.transaction(() => {
      // 1. 收尾当前 assistant 草稿：取消 → interrupted，失败 → failed。
      //    另清扫 Run 内其它未终态消息（如首轮请求前失败悬挂的 pending 草稿）。
      const drafts = [
        ...(snapshot.turn !== null ? [snapshot.turn] : []),
        ...this.store.messages
          .listPendingByRun(run.id)
          .map((message) => ({
            id: message.id,
            content: message.content,
            reasoning: message.reasoning,
          }))
          .filter((draft) => draft.id !== snapshot.turn?.id),
      ]
      for (const draft of drafts) {
        const status =
          decision.status === 'cancelled'
            ? 'interrupted'
            : decision.status === 'failed'
              ? 'failed'
              : 'completed'
        this.store.messages.finalize(
          draft.id,
          decision.pendingMessage?.content ?? draft.content,
          status,
          decision.pendingMessage?.reasoning ?? draft.reasoning,
          decision.pendingMessage?.parts,
        )
      }
      // 2. 未终态 ToolCall 统一取消（in-flight 快照 + 数据库内非终态行）。
      const nonTerminal = this.store.toolCalls
        .listByRun(run.id)
        .filter(
          (call) =>
            call.status === 'pending' ||
            call.status === 'running' ||
            call.status === 'awaiting_approval',
        )
        .map((call) => call.id)
      const cancelledToolCallIds = [
        ...new Set([...snapshot.inFlightToolCallIds, ...nonTerminal]),
      ]
      for (const id of cancelledToolCallIds) {
        this.store.toolCalls.finalize(id, 'cancelled')
      }
      // 3. 收敛关联活动计划。
      const updatedPlan =
        decision.planDisposition === 'keep'
          ? null
          : this.convergePlan(run, decision)
      // 4. Run 终态。
      this.store.runs.finalize(
        run.id,
        decision.status,
        decision.errorCode ?? undefined,
      )
      // 5. 失败事件持久化。
      if (decision.status === 'failed') {
        this.store.runEvents.createFailed({
          sessionId: run.sessionId,
          runId: run.id,
          errorCode: decision.errorCode ?? 'internal',
          errorMessage: decision.errorMessage ?? 'Run failed',
        })
      }
      return { cancelledToolCallIds, updatedPlan }
    })
  }

  /** 计划收敛：返回收敛后的 Plan（用于事件），无可收敛计划返回 null。 */
  private convergePlan(run: Run, decision: RunTerminalDecision): Plan | null {
    // Plan linkage may be created by manage_plan during this Run; re-read by runId.
    const currentRun = this.store.runs.get(run.id)
    const planId = currentRun?.planId ?? run.planId
    if (!planId) return null
    try {
      const linked = this.store.plans.get(planId)
      if (
        !linked ||
        linked.sessionId !== run.sessionId ||
        linked.status !== 'active'
      ) {
        return null
      }
      const summary =
        decision.errorMessage ??
        (decision.status === 'cancelled' ? 'Run 已被取消' : 'Run 失败')
      // 未完成步骤随 Plan 一并收敛（plans.fail 只改 Plan 状态本身）。
      this.store.plans.failPendingSteps(planId)
      return decision.planDisposition === 'cancel'
        ? this.store.plans.cancel(planId, summary)
        : this.store.plans.fail(planId, summary)
    } catch (error) {
      // 计划收敛失败不应掩盖 Run 的真实终态。
      process.stderr.write(
        `[runtime] plan convergence skipped (${planId}): ${describeError(error)}\n`,
      )
      return null
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
