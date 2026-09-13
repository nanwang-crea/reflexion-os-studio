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
    // 身份对象冻结：公开字段，防运行期被外部改写后污染全部信封。
    Object.freeze(identity)
    this.scope = identity.scope
  }

  next(event: { type: RuntimeEvent['type'] } & Record<string, unknown>): void {
    const candidate = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      seq: this.seq++,
      occurredAt: new Date().toISOString(),
      ...event,
      // identity 后置 = 绝对权威：载荷不得覆写信封身份字段。
      ...this.identity,
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

/**
 * 资源事件发射器注册表：以「作用域 + 资源身份」为 key 缓存长生命周期 emitter，
 * 保证同一资源流内 seq 单调、跨资源独立。取代各服务各自手写的 Map（行为等价）。
 * key 取 identity 中实际出现的资源字段拼接，缺省字段以空串占位避免歧义碰撞。
 */
export class EmitterRegistry {
  private readonly emitters = new Map<string, ResourceEventEmitter>()

  constructor(private readonly notifier: EventNotifier) {}

  key(identity: EventIdentity): string {
    const id = identity as Record<string, unknown>
    return [
      identity.scope,
      (id.runId as string) ?? '',
      (id.sessionId as string) ?? '',
      (id.projectId as string) ?? '',
      (id.terminalId as string) ?? '',
      (id.serverId as string) ?? '',
    ].join(':')
  }

  /** get-or-create：命中复用（保留已积累的 seq），未命中则新建。 */
  for(identity: EventIdentity): ResourceEventEmitter {
    const key = this.key(identity)
    let emitter = this.emitters.get(key)
    if (!emitter) {
      emitter = new ResourceEventEmitter(identity, this.notifier)
      this.emitters.set(key, emitter)
    }
    return emitter
  }

  /** 资源销毁（会话/服务器/终端删除）时驱逐，防止 Map 无界增长。 */
  evict(identity: EventIdentity): void {
    this.emitters.delete(this.key(identity))
  }

  /** 全量清空（服务 dispose / 进程退出路径）。 */
  clear(): void {
    this.emitters.clear()
  }
}
