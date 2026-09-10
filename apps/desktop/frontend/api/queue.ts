import type {
  QueueEntry,
  RuntimeEvent,
} from '@reflexion-os-studio/runtime-client'
import { request } from './client'
import { transport } from '../lib/transport'

/** 队列快照;join 会话/对话页打开时拉取。paused：停止回复后的暂停待确认态。 */
export function listQueue(
  sessionId: string,
): Promise<{ items: QueueEntry[]; paused?: boolean }> {
  return request<{ items: QueueEntry[]; paused?: boolean }>('queue.list', {
    sessionId,
  })
}

export function updateQueue(
  sessionId: string,
  queueId: string,
  content: string,
): Promise<{ item: QueueEntry | null }> {
  return request<{ item: QueueEntry | null }>('queue.update', {
    sessionId,
    queueId,
    content,
  })
}

export function removeQueue(
  sessionId: string,
  queueId: string,
): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>('queue.remove', { sessionId, queueId })
}

export function sendNow(
  sessionId: string,
  queueId: string,
): Promise<{ accepted: boolean }> {
  return request<{ accepted: boolean }>('queue.send_now', {
    sessionId,
    queueId,
  })
}

/** 解除停止回复后的队列暂停；会话空闲且队列非空则立即出队发送。 */
export function resumeQueue(sessionId: string): Promise<{ resumed: boolean }> {
  return request<{ resumed: boolean }>('queue.resume', { sessionId })
}

export function onQueueChanged(
  handler: (sessionId: string, items: QueueEntry[], paused?: boolean) => void,
): () => void {
  return transport.onEvent((event: RuntimeEvent) => {
    if (event.type === 'queue.changed') {
      handler(event.sessionId, event.items, event.paused)
    }
  })
}
