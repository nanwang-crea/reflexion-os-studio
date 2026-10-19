import { resourcesConflict } from '../delegation/resource-locks.js'
import type {
  ToolCallRequest,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import type { JsonValue } from '@reflexion-os-studio/contracts'
import { finalizeRejectedTool, type RunExecutionState } from './run-state.js'
import type { Run } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import type { RunEventEmitter } from '../../events.js'
import { parseToolArgs } from './tool-executor.js'
import { ChildLimitError } from '../errors.js'
import type { ApprovalGateway, PermissionGate } from '../permissions/index.js'

/**
 * 副作用感知工具调度器（W3）：
 * 同一模型轮的调用保持声明顺序，切分为执行批次——
 * - 相邻 pure/read 调用组成最多 8 项的并行批次；
 * - 可信单文件 write 可按互斥资源键并行，其他 write/shell/state 独占批次；
 * - mutation 完成后，后续 read 才能开始（禁止交叉）；
 * - 结果始终按模型原始调用顺序回填。
 */

export interface SchedulerDeps {
  completedCalls?: ReadonlyMap<string, ToolResult>
  store: Store
  state: RunExecutionState
  run: Run
  gate: PermissionGate
  approvals: ApprovalGateway
  workspaceRoot: string | null
  registry: ToolRegistry
  emitter: RunEventEmitter
  /** 单请求执行器（tool-executor 的 executeToolCall）。 */
  executeOne: (
    request: ToolCallRequest,
    signal: AbortSignal,
  ) => Promise<ToolResult>
  /** Loop Guard（W4）：重复 mutation 拦截与无进展指纹；缺省不启用。 */
  guard?: {
    admit(request: ToolCallRequest): {
      verdict: 'allow' | 'block'
      code?: string
      message?: string
      terminal?: boolean
    }
    recordExecution(
      request: ToolCallRequest,
      result: ToolResult,
      mutation: boolean,
      protectReplay?: boolean,
    ): void
    recordBlocked(request: ToolCallRequest): void
  }
}

interface PlannedCall {
  /** 原始声明位置。 */
  index: number
  request: ToolCallRequest
  effect: 'pure' | 'read' | 'write' | 'shell' | 'state'
  resourceKeys: string[]
  concurrentSafe?: boolean
  protectReplay?: boolean
}

/** 解析执行策略；未知工具（registry 会回 unsupported）按 state 保守串行。 */
function planCall(
  deps: SchedulerDeps,
  request: ToolCallRequest,
  index: number,
): PlannedCall {
  const definition: ToolDefinition | undefined = deps.registry
    .list()
    .find((tool) => tool.name === request.name)
  const policy = definition?.execution
  const args: JsonValue = parseToolArgs(request.arguments)
  let effect: PlannedCall['effect'] = 'state'
  let resourceKeys: string[] = []
  if (policy !== undefined) {
    effect = policy.effect
    try {
      resourceKeys = policy.resourceKeys?.(args) ?? []
    } catch {
      resourceKeys = []
    }
  }
  return {
    index,
    request,
    effect,
    resourceKeys,
    concurrentSafe: policy?.concurrentSafe,
    protectReplay: policy?.idempotent !== true,
  }
}

/** Read segments and explicitly safe disjoint writes share bounded batches.
 * Read/write, Shell, state and unknown side effects remain ordering barriers.
 */
export function planBatches(calls: PlannedCall[]): PlannedCall[][] {
  const batches: PlannedCall[][] = []
  let pending: PlannedCall[] = []
  let mode: 'read' | 'write' | null = null
  const flush = () => {
    if (pending.length) batches.push(pending)
    pending = []
    mode = null
  }
  for (const call of calls) {
    const nextMode =
      call.effect === 'pure' || call.effect === 'read'
        ? 'read'
        : call.effect === 'write' &&
            call.concurrentSafe &&
            call.resourceKeys.length
          ? 'write'
          : null
    if (nextMode === null) {
      flush()
      batches.push([call])
      continue
    }
    if (
      mode !== nextMode ||
      pending.length >= 8 ||
      pending.some(
        (item) =>
          (nextMode === 'write' ||
            (item.resourceKeys.length > 0 && call.resourceKeys.length > 0)) &&
          resourcesConflict(item.resourceKeys, call.resourceKeys),
      )
    )
      flush()
    mode = nextMode
    pending.push(call)
  }
  flush()
  return batches
}

/** 单请求包装：Loop Guard admit → 执行 → record；被拦截不执行、返回稳定错误。 */
async function guardedExecuteOne(
  deps: SchedulerDeps,
  planned: PlannedCall,
  signal: AbortSignal,
  recovery: { warned: boolean },
): Promise<ToolResult> {
  const completed = deps.completedCalls?.get(planned.request.id)
  if (completed) return completed
  deps.state.metrics?.add('toolCalls')
  if (deps.guard !== undefined) {
    const admission = deps.guard.admit(planned.request)
    if (admission.verdict === 'block') {
      deps.guard.recordBlocked(planned.request)
      deps.state.metrics?.add('toolFailures')
      if (planned.request.name === 'file.edit')
        deps.state.metrics?.add('editFailures')
      const result = finalizeRejectedTool(
        deps,
        planned.request,
        {
          content: admission.message ?? 'loop guard blocked this call',
          isError: true,
          code: admission.code ?? 'no_progress',
        },
        parseToolArgs(planned.request.arguments),
        deps.store.sessions.get(deps.run.sessionId)?.projectId ?? null,
      )
      // 首次无进展作为工具错误回传，留出恢复/说明机会；再次重放才终止。
      if (admission.terminal && !recovery.warned) {
        const limit = new ChildLimitError(
          'no_progress',
          admission.message ?? '检测到重复无进展的执行循环，已停止',
        )
        throw limit
      }
      recovery.warned = true
      return result
    }
  }
  const result = await deps.executeOne(planned.request, signal)
  if (result.isError) {
    deps.state.metrics?.add('toolFailures')
    if (planned.request.name === 'file.edit')
      deps.state.metrics?.add('editFailures')
  }
  if (deps.guard !== undefined) {
    deps.guard.recordExecution(
      planned.request,
      result,
      isMutation(planned.effect),
      planned.protectReplay,
    )
  }
  return result
}

function isMutation(effect: PlannedCall['effect']): boolean {
  return effect === 'write' || effect === 'shell' || effect === 'state'
}

/**
 * 批量执行入口：供 AgentLoopOptions.executeToolBatch 注入。
 * 返回结果数组与请求顺序一一对应。
 */
export async function executeToolBatch(
  deps: SchedulerDeps,
  requests: ToolCallRequest[],
  signal: AbortSignal,
): Promise<ToolResult[]> {
  const planned = requests.map((request, index) =>
    planCall(deps, request, index),
  )
  const batches = planBatches(planned)
  const results: ToolResult[] = new Array(requests.length)
  // 同一模型轮的多条重复声明只反馈，不抢在模型看到提示前终止。
  const recovery = { warned: false }
  try {
    for (const batch of batches) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      if (batch.length === 1) {
        const call = batch[0]
        results[call.index] = await guardedExecuteOne(
          deps,
          call,
          signal,
          recovery,
        )
        continue
      }
      // 只读并行批次：Promise.all 保持请求顺序回填（结果数组按下标归位）。
      const settled = await Promise.allSettled(
        batch.map((call) => guardedExecuteOne(deps, call, signal, recovery)),
      )
      for (let i = 0; i < batch.length; i += 1) {
        const entry = settled[i]
        if (entry.status === 'fulfilled') results[batch[i].index] = entry.value
      }
      const failed = settled.find((entry) => entry.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  } finally {
    // 本轮全部请求已消费预建行；清除映射避免下一轮误用。
    deps.state.precreatedToolCallRows.clear()
  }
  return results
}

/** Early reads use the same guard/executor without clearing the current batch. */
export function executeScheduledCall(
  deps: SchedulerDeps,
  request: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolResult> {
  return guardedExecuteOne(deps, planCall(deps, request, 0), signal, {
    warned: false,
  })
}
