import {
  RuntimeEventSchema,
  lookupCommandSchema,
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
    super(enrichMessage(message, runtimeError))
    this.name = 'TransportError'
    this.runtimeError = runtimeError
  }
}

/**
 * JSON-RPC 标准错误里，`message` 是固定英文枚举（"Invalid params"、
 * "Method not found"），真实原因在 `error.data`。Runtime 侧 -32602 的 data
 * 是 `path: 中文说明` 字符串数组（不含入参值）。这里把明细并入 message，
 * 让所有只 catch `Error.message` 的调用点都能显示原因，不再吞掉细节。
 */
function enrichMessage(
  message: string,
  runtimeError?: JsonRpcErrorDetail,
): string {
  const data = runtimeError?.data
  if (Array.isArray(data) && data.length > 0) {
    const detail = data
      .filter((item): item is string => typeof item === 'string')
      .join('；')
    if (detail) return `${message}：${detail}`
  }
  return message
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: TransportError) => void
  timer: ReturnType<typeof setTimeout>
}

/** 响应先于 invoke 回执到达时的暂存条目。 */
interface EarlyResponse {
  result?: unknown
  error?: JsonRpcErrorDetail
  receivedAt: number
}

const EARLY_RESPONSE_TTL_MS = 15_000

/** 非事件类通知：runtime.ready 是握手信号，由宿主消费，不经事件通道。 */
const NON_EVENT_NOTIFICATION_METHODS = new Set(['runtime.ready'])

/**
 * 前端访问 Runtime 的唯一 typed 通道。
 * 响应按 JSON-RPC id 关联（Host 只负责透传），事件按通知分发。
 */
export class RuntimeTransport {
  private readonly pending = new Map<number, PendingRequest>()
  private readonly awaitingAcks = new Set<(error: TransportError) => void>()
  private readonly earlyResponses = new Map<number, EarlyResponse>()
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
    for (const reject of this.awaitingAcks)
      reject(new TransportError('transport disposed'))
    this.awaitingAcks.clear()
    this.earlyResponses.clear()
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
    return new Promise<R>((resolve, reject) => {
      let id: number | undefined
      let settled = false
      const finish = (): void => {
        settled = true
        clearTimeout(timer)
        if (id !== undefined) this.pending.delete(id)
        this.awaitingAcks.delete(fail)
      }
      const fail = (error: unknown): void => {
        if (settled) return
        finish()
        reject(error)
      }
      const accept = (result: unknown): void => {
        if (settled) return
        try {
          const validated = this.validateResult<R>(method, result)
          finish()
          resolve(validated)
        } catch (error) {
          fail(error)
        }
      }
      // The deadline includes Host acknowledgement, not just Runtime response.
      const timer = setTimeout(() => {
        fail(new TransportError(`runtime request timeout: ${method}`))
      }, timeoutMs)
      this.awaitingAcks.add(fail)
      Promise.resolve()
        .then(() => {
          if (settled) return undefined
          return this.options.invoke<number>('runtime_request', {
            method,
            params: params ?? {},
          })
        })
        .then((receipt) => {
          if (receipt === undefined) return
          id = receipt
          this.awaitingAcks.delete(fail)
          if (settled) {
            this.earlyResponses.delete(id)
            return
          }
          // Responses may arrive before the Host acknowledgement.
          const early = this.earlyResponses.get(id)
          if (early) {
            this.earlyResponses.delete(id)
            if (early.error)
              fail(new TransportError(early.error.message, early.error))
            else accept(early.result)
            return
          }
          this.pending.set(id, { resolve: accept, reject: fail, timer })
        }, fail)
    })
  }

  /** 按 contracts 注册表对命令响应做运行时校验；未知命令或校验失败时按策略处理。 */
  private validateResult<R>(method: string, result: unknown): R {
    const schema = lookupCommandSchema(method)?.result
    if (!schema) return result as R
    const parsed = schema.safeParse(result)
    if (!parsed.success) {
      throw new TransportError(
        `runtime response validation failed for ${method}: ${parsed.error.message}`,
      )
    }
    return parsed.data as R
  }

  private handleMessage(payload: TransportSidecarMessage): void {
    if (payload.name !== 'runtime') return
    const message = payload.message as Record<string, unknown> | null
    if (!message) return

    if (typeof message.method === 'string' && message.id === undefined) {
      if (NON_EVENT_NOTIFICATION_METHODS.has(message.method)) {
        return
      }
      const parsed = RuntimeEventSchema.safeParse(message.params)
      if (parsed.success) {
        for (const handler of this.eventHandlers) {
          handler(parsed.data)
        }
      } else {
        // 版本代际不一致/畸形事件必须显式可见（架构红线：降级不等于静默）。
        console.warn(
          `[runtime-client] dropped malformed event ${message.method}:`,
          parsed.error.issues.slice(0, 3),
        )
      }
      return
    }

    if (typeof message.id === 'number' && !('method' in message)) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        // 响应先于 invoke 回执到达：暂存等 request() 注册后补交。
        const now = Date.now()
        for (const [key, value] of this.earlyResponses) {
          if (now - value.receivedAt > EARLY_RESPONSE_TTL_MS) {
            this.earlyResponses.delete(key)
          }
        }
        this.earlyResponses.set(message.id, {
          result: message.result,
          error: message.error as JsonRpcErrorDetail | undefined,
          receivedAt: now,
        })
        return
      }
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
