import type {
  QueueEntry,
  RuntimeEvent,
} from '@reflexion-os-studio/runtime-client'
import { request } from './client'
import { transport } from '../lib/transport'

/** 队列快照;join 会话/对话页打开时拉取。 */
export function listQueue(sessionId: string): Promise<{ items: QueueEntry[] }> {
  return request<{ items: QueueEntry[] }>('queue.list', { sessionId })
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

export function onQueueChanged(
  handler: (sessionId: string, items: QueueEntry[]) => void,
): () => void {
  return transport.onEvent((event: RuntimeEvent) => {
    if (event.type === 'queue.changed') {
      handler(event.sessionId, event.items)
    }
  })
}
