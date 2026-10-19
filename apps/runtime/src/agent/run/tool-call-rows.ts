import {
  JsonValueSchema,
  type JsonValue,
  type Run,
} from '@reflexion-os-studio/contracts'
import type { ToolCallRequest } from '@reflexion-os-studio/agent-core'
import type { Store } from '../../store/index.js'
import type { RunEventEmitter } from '../../events.js'
import type { RunExecutionState } from './run-state.js'

/** Reuse admitted streamed rows; precreate all remaining declarations in order. */
export function precreateToolCalls(
  store: Store,
  state: RunExecutionState,
  run: Run,
  emitter: RunEventEmitter,
  calls: ToolCallRequest[],
): void {
  const rows = store.transaction(() =>
    calls.flatMap((call) => {
      if (state.precreatedToolCallRows.has(call.id)) return []
      const row = store.toolCalls.create({
        runId: run.id,
        messageId: state.lastAssistantMessageId,
        toolName: call.name,
        args: parseToolArgsForPrecreate(call.arguments),
        status: 'pending',
      })
      return [{ call, row }]
    }),
  )
  for (const { call, row } of rows)
    state.precreatedToolCallRows.set(call.id, row.id)
  for (const { call, row } of rows)
    emitter.next({
      type: 'tool.requested',
      toolCallId: row.id,
      toolName: call.name,
      args: row.args,
    })
}

function parseToolArgsForPrecreate(value: string): JsonValue {
  try {
    const result = JsonValueSchema.safeParse(
      JSON.parse(value.trim() === '' ? '{}' : value),
    )
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}
