import type {
  ToolCallRequest,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import type { JsonValue, Run } from '@reflexion-os-studio/contracts'
import { normalizeToolOutput } from './toolResults.js'
import type { ToolOutput } from '@reflexion-os-studio/contracts'
import type { RunEventEmitter } from '../../events.js'
import type { Store } from '../../store/index.js'

/** 未落终态的模型轮次草稿：取消/失败时把已累积内容一并收尾。 */
export interface TurnDraft {
  id: string
  content: string
  reasoning: string
}

/** 单次 Run 执行期的可变状态：轮次草稿 + 未收尾工具调用行 + 预建行映射。 */
export interface RunExecutionState {
  /** 当前持久化 TurnExecution；每次模型调用开始时替换。 */
  currentTurnId: string | null
  /** 流式中断/失败时未落终态的当前轮次草稿。 */
  turn: TurnDraft | null
  /** 进行中未落终态的工具调用行（同轮并行时可能多个）。 */
  toolCallRowIds: Set<string>
  /** 最近一条 assistant 消息（工具调用行的关联消息）。 */
  lastAssistantMessageId: string | null
  /** 预建 ToolCall 行：provider call id → row id（W3 批量预建）。 */
  precreatedToolCallRows: Map<string, string>
}

export function createRunExecutionState(): RunExecutionState {
  return {
    currentTurnId: null,
    turn: null,
    toolCallRowIds: new Set(),
    lastAssistantMessageId: null,
    precreatedToolCallRows: new Map(),
  }
}

/** 工具调用行收尾的统一出口：清 in-flight 记录 → 落库 → 事件。 */
export function finalizeToolCall(
  store: Store,
  state: RunExecutionState,
  emitter: RunEventEmitter,
  rowId: string,
  status: 'completed' | 'failed' | 'cancelled',
  errorCode: string | null,
  output?: ToolOutput,
): void {
  state.toolCallRowIds.delete(rowId)
  store.toolCalls.finalize(rowId, status, output, errorCode ?? undefined)
  emitter.next({
    type: 'tool.completed',
    toolCallId: rowId,
    status,
    errorCode,
  })
}

/** Persist requests rejected before execution, including metadata preflight failures. */
export function finalizeRejectedTool(
  input: {
    store: Store
    state: RunExecutionState
    run: Run
    emitter: RunEventEmitter
  },
  request: ToolCallRequest,
  result: ToolResult,
  args: JsonValue,
  projectId: string | null,
): ToolResult {
  const { store, state, run, emitter } = input
  const precreatedId = state.precreatedToolCallRows.get(request.id)
  const existing =
    precreatedId === undefined ? null : store.toolCalls.get(precreatedId)
  const row =
    existing ??
    store.toolCalls.create({
      runId: run.id,
      messageId: state.lastAssistantMessageId,
      toolName: request.name,
      args,
      status: 'pending',
    })
  if (existing === null) {
    emitter.next({
      type: 'tool.requested',
      toolCallId: row.id,
      toolName: request.name,
      args,
    })
  }
  finalizeToolCall(
    store,
    state,
    emitter,
    row.id,
    'failed',
    result.code ?? 'invalid_request',
    normalizeToolOutput(result, projectId, request.name),
  )
  return result
}
