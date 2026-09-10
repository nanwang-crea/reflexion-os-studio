import { randomUUID } from 'node:crypto'
import type { QueueEntry } from '@reflexion-os-studio/contracts'
import type { ChatCommand } from '@reflexion-os-studio/contracts'
import { RunEventEmitter, type EventNotifier } from '../events.js'

/** 队列等待项:发送参数(不含 requestId/sessionId,由出队时补全)。 */
export interface QueuedItem {
  id: string
  params: Omit<ChatCommand, 'requestId' | 'sessionId'>
}

/**
 * 会话发送队列(内存,FIFO,每会话一条):上一条回复结束由 pump 自动出队发送。
 * 重启即丢失(排队窗口短,不持久化);变更经 queue.changed 事件广播快照。
 */
export class QueueService {
  /** 会话 → 排队项（内存，重启即丢失）。 */
  private readonly queues = new Map<string, QueuedItem[]>()
  /** 用户停止 Run 后的会话级暂停标记：暂停期间 pump 不自动出队，等 queue.resume 确认。 */
  private readonly paused = new Set<string>()

  constructor(private readonly notifier: EventNotifier) {}

  enqueue(sessionId: string, params: QueuedItem['params']): QueuedItem {
    const entry: QueuedItem = { id: randomUUID(), params }
    const queue = this.queues.get(sessionId) ?? []
    queue.push(entry)
    this.queues.set(sessionId, queue)
    this.notify(sessionId)
    return entry
  }

  list(sessionId: string): QueueEntry[] {
    return (this.queues.get(sessionId) ?? []).map((entry, position) =>
      this.toEntry(sessionId, entry, position),
    )
  }

  get(sessionId: string, queueId: string): QueuedItem | null {
    return (
      (this.queues.get(sessionId) ?? []).find(
        (entry) => entry.id === queueId,
      ) ?? null
    )
  }

  /** 修改排队内容(斜杠技能解析由调用方完成,见 ChatAgent.updateQueued)。 */
  update(
    sessionId: string,
    queueId: string,
    params: QueuedItem['params'],
  ): QueuedItem | null {
    const queue = this.queues.get(sessionId)
    const entry = (queue ?? []).find((item) => item.id === queueId)
    if (!queue || !entry) return null
    entry.params = params
    this.notify(sessionId)
    return entry
  }

  /** 会话删除时清空其队列(残留项永无发送机会)。 */
  removeSession(sessionId: string): void {
    this.queues.delete(sessionId)
    this.paused.delete(sessionId)
  }

  remove(sessionId: string, queueId: string): boolean {
    const queue = this.queues.get(sessionId)
    if (!queue) return false
    const next = queue.filter((entry) => entry.id !== queueId)
    if (next.length === queue.length) return false
    this.queues.set(sessionId, next)
    this.notify(sessionId)
    return true
  }

  /** 立即发送:移到队首并广播;实际触发由调用方按空闲与否决定。 */
  moveToFront(sessionId: string, queueId: string): boolean {
    const queue = this.queues.get(sessionId)
    const index = (queue ?? []).findIndex((entry) => entry.id === queueId)
    if (!queue || index < 0) return false
    if (index === 0) return true
    const [entry] = queue.splice(index, 1)
    queue.unshift(entry)
    this.notify(sessionId)
    return true
  }

  /** 弹出队首(发送成功即出队);返回 null 表示队列空。 */
  dequeue(sessionId: string): QueuedItem | null {
    const queue = this.queues.get(sessionId) ?? []
    const entry = queue.shift() ?? null
    if (queue.length > 0) this.queues.set(sessionId, queue)
    else this.queues.delete(sessionId)
    if (entry) this.notify(sessionId)
    return entry
  }

  /** 停止 Run 后暂停自动出队;返回 false 表示此前未处于暂停态。 */
  pause(sessionId: string): boolean {
    if (this.paused.has(sessionId)) return false
    this.paused.add(sessionId)
    this.notify(sessionId)
    return true
  }

  /** 用户确认后解除暂停;返回 false 表示本来就没在暂停。 */
  resume(sessionId: string): boolean {
    if (!this.paused.delete(sessionId)) return false
    this.notify(sessionId)
    return true
  }

  isPaused(sessionId: string): boolean {
    return this.paused.has(sessionId)
  }

  private toEntry(
    sessionId: string,
    entry: QueuedItem,
    position: number,
  ): QueueEntry {
    return {
      id: entry.id,
      sessionId,
      content: entry.params.content,
      providerId: entry.params.providerId ?? null,
      model: entry.params.model ?? null,
      permissionMode: entry.params.permissionMode ?? null,
      trusted: entry.params.trusted ?? false,
      skillId: entry.params.skillId ?? null,
      position,
    }
  }

  private notify(sessionId: string): void {
    const emitter = new RunEventEmitter(sessionId, this.notifier)
    emitter.next({
      type: 'queue.changed',
      sessionId,
      paused: this.isPaused(sessionId),
      items: this.list(sessionId),
    })
  }
}
