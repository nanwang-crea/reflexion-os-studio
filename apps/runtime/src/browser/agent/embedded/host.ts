import { randomUUID } from 'node:crypto'
import { HostBrowserControlSchema } from '@reflexion-os-studio/contracts'
import {
  HostBrowserRequestSchema,
  type HostBrowserRequest,
  type JsonRpcMessage,
} from '@reflexion-os-studio/contracts'

/** Private stdio peer; endpoint responses never enter frontend events or history. */
export class HostBrowserTransport {
  private closed = false
  private readonly listeners = new Set<
    (lease: string, paused: boolean) => void
  >()
  onControl(listener: (lease: string, paused: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  constructor(private readonly write: (message: JsonRpcMessage) => void) {}
  request(raw: HostBrowserRequest): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('browser_closed'))
    const params = HostBrowserRequestSchema.parse(raw)
    const id = `host-browser:${randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('browser_host_timeout'))
      }, 15000)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ jsonrpc: '2.0', id, method: 'host.browser', params })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('browser_unavailable'))
      }
    })
  }
  receive(message: JsonRpcMessage): boolean {
    if ('method' in message && message.method === 'host.browser.control') {
      const parsed = HostBrowserControlSchema.safeParse(message.params)
      if (parsed.success)
        for (const listener of this.listeners)
          listener(parsed.data.lease, parsed.data.paused)
      return true
    }
    if (
      'method' in message ||
      typeof message.id !== 'string' ||
      !message.id.startsWith('host-browser:')
    )
      return false
    const pending = this.pending.get(message.id)
    if (!pending) return true
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error)
      pending.reject(
        new Error(
          /^browser_[a-z_]+$/.test(message.error.message)
            ? message.error.message
            : 'browser_operation_failed',
        ),
      )
    else pending.resolve(message.result)
    return true
  }
  dispose(): void {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('browser_closed'))
    }
    this.pending.clear()
  }
}
