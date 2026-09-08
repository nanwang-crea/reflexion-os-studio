import type {
  ToolCallRequest,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import type { JsonValue } from '@reflexion-os-studio/contracts'
import type { RunExecutionState } from './run-state.js'
import type { Run } from '@reflexion-os-studio/contracts'
import type { Store } from '../store/index.js'
import type { RunEventEmitter } from '../events.js'
import { parseToolArgs } from './tool-executor.js'
import type { ApprovalGateway, PermissionGate } from './permissions.js'

/**
 * 副作用感知工具调度器（W3）：
 * 同一模型轮的调用保持声明顺序，切分为执行批次——
 * - 相邻 pure/read 且资源不冲突的调用组成并行批次；
 * - write/shell/state 每个调用单独成串行批次；
 * - mutation 完成后，后续 read 才能开始（禁止交叉）；
 * - 结果始终按模型原始调用顺序回填。
 */

export interface SchedulerDeps {
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
}

interface PlannedCall {
  /** 原始声明位置。 */
  index: number
  request: ToolCallRequest
  effect: 'pure' | 'read' | 'write' | 'shell' | 'state'
  resourceKeys: string[]
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
  return { index, request, effect, resourceKeys }
}

/** 资源键有交集视为冲突（同路径读写互斥）。 */
function resourcesConflict(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  return a.some((key) => b.includes(key))
}

/**
 * 按声明顺序切分批次：只读段合并并行，mutation 独占批次。
 * 导出供单测直接验证切分语义。
 */
export function planBatches(calls: PlannedCall[]): PlannedCall[][] {
  const batches: PlannedCall[][] = []
  let readRun: PlannedCall[] = []
  const flushReadRun = (): void => {
    if (readRun.length > 0) {
      batches.push(readRun)
      readRun = []
    }
  }
  for (const call of calls) {
    if (call.effect === 'pure' || call.effect === 'read') {
      // 与当前只读段内任一调用资源冲突 → 先结算再开新段。
      if (
        readRun.some((pending) =>
          resourcesConflict(pending.resourceKeys, call.resourceKeys),
        )
      ) {
        flushReadRun()
      }
      readRun.push(call)
      continue
    }
    // mutation：独占批次（先结算只读段，保证 read → mutation 顺序）。
    flushReadRun()
    batches.push([call])
  }
  flushReadRun()
  return batches
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
  try {
    for (const batch of batches) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      if (batch.length === 1) {
        const call = batch[0]
        results[call.index] = await deps.executeOne(call.request, signal)
        continue
      }
      // 只读并行批次：Promise.all 保持请求顺序回填（结果数组按下标归位）。
      const settled = await Promise.all(
        batch.map((call) => deps.executeOne(call.request, signal)),
      )
      for (let i = 0; i < batch.length; i += 1) {
        results[batch[i].index] = settled[i]
      }
    }
  } finally {
    // 本轮全部请求已消费预建行；清除映射避免下一轮误用。
    deps.state.precreatedToolCallRows.clear()
  }
  return results
}
