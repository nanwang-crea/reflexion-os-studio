import type {
  Message,
  RuntimeEvent,
  SessionHistory,
} from '@reflexion-os-studio/contracts'

/** Provider continuation and request diagnostics are execution internals. */
function messageView(message: Message): Message {
  const view = { ...message }
  delete view.providerContinuation
  delete view.requestAttempts
  return view
}
export function remoteHistory(history: SessionHistory): SessionHistory {
  return { ...history, messages: history.messages.map(messageView) }
}
export function remoteEvent(event: RuntimeEvent): RuntimeEvent {
  if (event.type === 'message.created')
    return { ...event, message: messageView(event.message) }
  if (event.type === 'operation.changed')
    return {
      ...event,
      operation: {
        ...event.operation,
        error: event.operation.error ? '操作失败，请在电脑查看详情' : null,
      },
    }
  return event
}
export function remoteCommandResult(method: string, result: unknown): unknown {
  if (method === 'session.get') return remoteHistory(result as SessionHistory)
  if (
    method === 'workspace.read_file' &&
    typeof result === 'object' &&
    result
  ) {
    const { content, sizeBytes, totalLines, offset, readComplete } =
      result as Record<string, unknown>
    return { content, sizeBytes, totalLines, offset, readComplete }
  }
  if (method === 'operation.get') {
    const value = result as { operation: Record<string, unknown> | null }
    return {
      operation: value.operation
        ? {
            ...value.operation,
            error: value.operation.error ? '操作失败，请在电脑查看详情' : null,
          }
        : null,
    }
  }
  return result
}
