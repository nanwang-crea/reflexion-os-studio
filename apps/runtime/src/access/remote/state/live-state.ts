import type { RuntimeEvent } from '@reflexion-os-studio/contracts'
type RunEvent = Extract<RuntimeEvent, { scope: 'run' }>
const LIMIT = 8 * 1024 * 1024

/** Retain only live state. Completed history stays owned by Store. */
export class RemoteLiveState {
  private readonly runs = new Map<string, Map<string, RunEvent>>()
  private readonly incomplete = new Map<string, RunEvent>()
  private bytes = 0
  readonly accept = (event: RuntimeEvent): void => {
    if (event.scope !== 'run') return
    const runId = event.runId
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
      const items = this.runs.get(runId)
      if (items)
        for (const item of items.values()) this.bytes -= this.size(item)
      this.runs.delete(runId)
      this.incomplete.delete(runId)
      return
    }
    const items = this.runs.get(runId) ?? new Map<string, RunEvent>()
    const remove = (key: string): void => {
      const old = items.get(key)
      if (old) this.bytes -= this.size(old)
      items.delete(key)
    }
    let key: string
    let value = event
    if (
      event.type === 'message.delta' ||
      event.type === 'message.reasoning_delta'
    ) {
      if (this.incomplete.has(runId)) return
      key = `${event.type}:${event.messageId}`
      const previous = items.get(key)
      if (previous?.type === event.type)
        value = { ...event, delta: previous.delta + event.delta }
    } else if (
      event.type === 'message.reset' ||
      event.type === 'message.completed'
    ) {
      remove(`message.delta:${event.messageId}`)
      remove(`message.reasoning_delta:${event.messageId}`)
      return
    } else if (event.type === 'approval.required')
      key = `approval:${event.toolCallId}`
    else if (event.type === 'approval.resolved') {
      remove(`approval:${event.toolCallId}`)
      return
    } else if (event.type === 'interaction.required')
      key = `interaction:${event.interactionId}`
    else if (event.type === 'interaction.resolved') {
      remove(`interaction:${event.interactionId}`)
      return
    } else if (event.type === 'run.model_activity') key = 'activity'
    else return
    remove(key)
    const draft =
      value.type === 'message.delta' || value.type === 'message.reasoning_delta'
    // Pending confirmations must remain recoverable even when draft storage is full.
    if (draft && this.bytes + this.size(value) > LIMIT) {
      const marker: RunEvent = {
        protocolVersion: event.protocolVersion,
        eventId: event.eventId,
        seq: event.seq,
        occurredAt: event.occurredAt,
        scope: 'run',
        runId,
        type: 'run.model_activity',
        phase: 'waiting',
        messageId: 'recovery',
      }
      // Never retain or show a partial reconstruction as a complete draft.
      for (const [id, item] of items)
        if (
          item.type === 'message.delta' ||
          item.type === 'message.reasoning_delta'
        )
          remove(id)
      this.incomplete.set(runId, marker)
      return
    }
    items.set(key, value)
    this.bytes += this.size(value)
    this.runs.set(runId, items)
  }
  snapshot(allowed: (event: RuntimeEvent) => boolean): {
    events: RuntimeEvent[]
    incomplete: boolean
  } {
    const events = [...this.runs.values()]
      .flatMap((items) => [...items.values()])
      .filter(allowed)
    // Missing retained data is explicit; callers must not present a truncated answer.
    return { events, incomplete: [...this.incomplete.values()].some(allowed) }
  }
  private size(event: RuntimeEvent): number {
    if (
      event.type === 'message.delta' ||
      event.type === 'message.reasoning_delta'
    )
      return event.delta.length * 2 + 512
    return Buffer.byteLength(JSON.stringify(event))
  }
}
