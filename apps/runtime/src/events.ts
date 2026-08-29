import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  RuntimeEventSchema,
  type RuntimeEvent,
} from '@reflexion-os-studio/contracts'

export type EventNotifier = (event: RuntimeEvent) => void

/** run 内单调递增信封 + 通知写出。 */
export class RunEventEmitter {
  private seq = 0

  constructor(
    readonly runId: string,
    private readonly notifier: EventNotifier,
  ) {}

  next(event: { type: RuntimeEvent['type'] } & Record<string, unknown>): void {
    const candidate = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      runId: this.runId,
      seq: this.seq++,
      occurredAt: new Date().toISOString(),
      ...event,
    }
    const parsed = RuntimeEventSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new Error(
        `runtime event failed schema: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      )
    }
    this.notifier(parsed.data)
  }
}
