import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  RuntimeEventSchema,
  type EventScope,
  type RuntimeEvent,
} from '@reflexion-os-studio/contracts'

export type EventNotifier = (event: RuntimeEvent) => void

/** 发射器身份 = 事件作用域 + 真实资源 ID（信封字段来源，单一构造点）。 */
export type EventIdentity =
  | { scope: 'runtime' }
  | { scope: 'run'; runId: string }
  | { scope: 'session'; sessionId: string }
  | { scope: 'project'; projectId: string }
  | { scope: 'mcp'; serverId: string }
  | { scope: 'terminal'; projectId: string; terminalId: string }

/**
 * 资源事件发射器：seq 在本实例代表的资源流内单调递增。
 * 每类资源应持有长生命周期实例（Map 缓存），禁止每次 emit 新建
 *（否则 seq 恒为 0，消费端无法排序/去重）。
 */
export class ResourceEventEmitter {
  private seq = 0
  readonly scope: EventScope

  constructor(
    readonly identity: EventIdentity,
    private readonly notifier: EventNotifier,
  ) {
    this.scope = identity.scope
  }

  next(event: { type: RuntimeEvent['type'] } & Record<string, unknown>): void {
    const candidate = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      ...this.identity,
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

/** run 通道便捷子类：构造签名与历史用法一致，agent/* 调用点零改动。 */
export class RunEventEmitter extends ResourceEventEmitter {
  constructor(runId: string, notifier: EventNotifier) {
    super({ scope: 'run', runId }, notifier)
  }

  get runId(): string {
    if (this.identity.scope !== 'run') {
      throw new Error('runId accessed on non-run emitter')
    }
    return this.identity.runId
  }
}
