import {
  RuntimeEventSchema,
  type JsonRpcErrorDetail,
  type RuntimeEvent,
} from '@reflexion-os-studio/contracts'

export interface TransportSidecarMessage {
  name: string
  message: unknown
}

export interface RuntimeTransportOptions {
  invoke: <T>(command: string, args?: unknown) => Promise<T>
  listen: <T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ) => Promise<() => void>
}

export class TransportError extends Error {
  readonly runtimeError?: JsonRpcErrorDetail

  constructor(message: string, runtimeError?: JsonRpcErrorDetail) {
    super(message)
    this.name = 'TransportError'
    this.runtimeError = runtimeError
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: TransportError) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 前端访问 Runtime 的唯一 typed 通道。
 * 响应按 JSON-RPC id 关联（Host 只负责透传），事件按通知分发。
 */
export class RuntimeTransport {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly eventHandlers = new Set<(event: RuntimeEvent) => void>()
  private unlisten?: () => void
  private queuedMessages: TransportSidecarMessage[] = []
  private attached = false

  constructor(private readonly options: RuntimeTransportOptions) {}

  async attach(): Promise<void> {
    if (this.attached) return
    this.unlisten = await this.options.listen<TransportSidecarMessage>(
      'bootstrap:message',
      (event) => {
        this.handleMessage(event.payload)
      },
    )
    this.attached = true
    for (const message of this.queuedMessages) {
      this.handleMessage(message)
    }
    this.queuedMessages = []
  }

  dispose(): void {
    this.unlisten?.()
    this.unlisten = undefined
    this.attached = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new TransportError('transport disposed'))
    }
    this.pending.clear()
    this.eventHandlers.clear()
  }

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => {
      this.eventHandlers.delete(handler)
    }
  }

  async request<R = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<R> {
    const id = await this.options.invoke<number>('runtime_request', {
      method,
      params: params ?? {},
    })
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new TransportError(`runtime request timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (result) => resolve(result as R),
        reject,
        timer,
      })
    })
  }

  private handleMessage(payload: TransportSidecarMessage): void {
    if (payload.name !== 'runtime') return
    const message = payload.message as Record<string, unknown> | null
    if (!message) return

    if (typeof message.method === 'string' && message.id === undefined) {
      const parsed = RuntimeEventSchema.safeParse(message.params)
      if (parsed.success) {
        for (const handler of this.eventHandlers) {
          handler(parsed.data)
        }
      }
      return
    }

    if (typeof message.id === 'number' && !('method' in message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const detail = message.error as JsonRpcErrorDetail
        pending.reject(new TransportError(detail.message, detail))
      } else {
        pending.resolve(message.result)
      }
    }
  }
}
