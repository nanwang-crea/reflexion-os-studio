import { isDeepStrictEqual } from 'node:util'
import { finalizeToolCall } from '../run-state.js'
import { normalizeToolOutput } from '../toolResults.js'
import type {
  ModelFinishReason,
  ToolCallRequest,
  ToolResult,
} from '@reflexion-os-studio/agent-core'
import { buildApprovalSubject } from '../../permissions/index.js'
import { executeToolCall } from '../tool-executor.js'
import type { ToolExecutorInput } from '../tool-executor-types.js'
import { executeScheduledCall, type SchedulerDeps } from '../tool-scheduler.js'
import { precreateToolCalls } from '../tool-call-rows.js'
import { ProviderError } from '../../../provider/provider-error.js'

const EARLY_READS = new Set([
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
  'get_current_time',
])
type SettledRead = { result: ToolResult } | { error: unknown }
interface EarlyRead {
  request: ToolCallRequest
  rowId: string
  controller: AbortController
  promise: Promise<SettledRead>
}

/** Execute only the closed, automatically admitted read prefix of a model stream.
 * Nothing here interprets partial JSON, changes approvals or speculates writes.
 */
export class StreamingReadCoordinator {
  private observed = new Map<string, ToolCallRequest>()
  private active = new Map<string, EarlyRead>()
  private abandoned: EarlyRead[] = []
  readonly completed = new Map<string, ToolResult>()

  constructor(
    private readonly input: ToolExecutorInput,
    private readonly options: Pick<SchedulerDeps, 'guard'> & {
      signal: AbortSignal
      admit: (request: ToolCallRequest) => boolean
    },
  ) {}

  observe(call: ToolCallRequest): void {
    this.observed.set(call.id, { ...call })
  }

  accept(call: ToolCallRequest): void {
    if (this.options.signal.aborted || this.active.size >= 8) return
    this.observe(call)
    const existing = this.active.get(call.id)
    if (existing) {
      if (!sameCall(existing.request, call))
        throw new ProviderError(
          'provider_protocol',
          'closed tool call changed during stream',
        )
      return
    }
    // Preserve model declaration ordering and never read ahead of a write or an
    // unknown/incomplete predecessor. Unsafe and unsupported calls wait for finish.
    for (const previous of this.observed.values()) {
      if (previous.id === call.id) break
      if (!this.active.has(previous.id)) return
    }
    if (!EARLY_READS.has(call.name)) return
    const validation = this.input.registry.validateRequest(call)
    if (!validation.ok) return
    const effect = validation.tool.execution?.effect
    if (effect !== 'pure' && effect !== 'read') return
    try {
      const { subject } = buildApprovalSubject(call.name, validation.args)
      if (
        this.input.gate.decisionFor({
          toolName: call.name,
          subject,
          escalation: false,
        }) !== 'automatic'
      )
        return
    } catch {
      return
    }
    if (!this.options.admit(call)) return
    const controller = new AbortController()
    const state = {
      ...this.input.state,
      precreatedToolCallRows: new Map<string, string>(),
    }
    precreateToolCalls(
      this.input.store,
      state,
      this.input.run,
      this.input.emitter,
      [call],
    )
    const rowId = state.precreatedToolCallRows.get(call.id)!
    const input = { ...this.input, state }
    const signal = AbortSignal.any([this.options.signal, controller.signal])
    const promise = executeScheduledCall(
      {
        ...input,
        ...this.options,
        executeOne: (request, childSignal) =>
          executeToolCall(input, request, childSignal),
      },
      call,
      signal,
    ).then(
      (result): SettledRead => ({ result }),
      (error): SettledRead => ({ error }),
    )
    this.active.set(call.id, {
      request: { ...call },
      rowId,
      controller,
      promise,
    })
    this.input.state.metrics?.add('streamedReads')
  }

  /** Called synchronously by Provider retry; stale reads can never satisfy the retry. */
  reset(): void {
    for (const entry of this.active.values()) {
      entry.controller.abort()
      this.abandoned.push(entry)
    }
    this.active.clear()
    this.observed.clear()
    this.completed.clear()
  }

  async finish(
    calls: ToolCallRequest[],
    reason: ModelFinishReason,
  ): Promise<void> {
    if (reason !== 'tool_calls') {
      await this.abandon()
      return
    }
    const entries = [...this.active.values()]
    const matches = entries.every(
      (entry, index) => calls[index] && sameCall(entry.request, calls[index]),
    )
    if (!matches) {
      await this.abandon()
      throw new ProviderError(
        'provider_protocol',
        'streamed read declarations differ from final tool calls',
      )
    }
    await this.drainAbandoned()
    const results = await Promise.all(entries.map((entry) => entry.promise))
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      const settled = results[index]
      if ('error' in settled) {
        await this.abandon()
        throw settled.error
      }
      this.completed.set(entry.request.id, settled.result)
      this.input.state.precreatedToolCallRows.set(entry.request.id, entry.rowId)
    }
    // A later budget failure must not detach valid native replay declarations.
    this.active.clear()
  }

  async abandon(): Promise<void> {
    this.reset()
    await this.drainAbandoned()
  }

  private async drainAbandoned(): Promise<void> {
    const entries = this.abandoned.splice(0)
    await Promise.all(entries.map((entry) => entry.promise))
    for (const entry of entries) {
      // Keep canonical audit outputs, but exclude abandoned declarations from
      // the successful attempt's assistant/native continuation history.
      const row = this.input.store.toolCalls.get(entry.rowId)
      if (row && !['completed', 'failed', 'cancelled'].includes(row.status)) {
        const result = {
          content: '提前读取所属请求已重试或取消，结果未用于模型历史',
          isError: true,
          code: 'cancelled',
        }
        finalizeToolCall(
          this.input.store,
          this.input.state,
          this.input.emitter,
          entry.rowId,
          'cancelled',
          'cancelled',
          normalizeToolOutput(result, null, entry.request.name),
        )
      }
      this.input.store.toolCalls.detachFromMessage(entry.rowId)
    }
  }
}

function sameCall(a: ToolCallRequest, b: ToolCallRequest): boolean {
  if (a.id !== b.id || a.name !== b.name) return false
  try {
    return isDeepStrictEqual(JSON.parse(a.arguments), JSON.parse(b.arguments))
  } catch {
    return false
  }
}
