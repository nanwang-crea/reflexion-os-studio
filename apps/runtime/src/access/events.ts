import type { RuntimeEvent } from '@reflexion-os-studio/contracts'
import type { EventNotifier } from '../events.js'

/** Delivery is separate from publication; one failed client cannot break a Run. */
export class RuntimeEventBus {
  private readonly listeners = new Set<EventNotifier>()
  constructor(private readonly onError: (error: unknown) => void = () => {}) {}
  readonly publish = (event: RuntimeEvent): void => {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.onError(error)
      }
    }
  }
  subscribe(listener: EventNotifier): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
