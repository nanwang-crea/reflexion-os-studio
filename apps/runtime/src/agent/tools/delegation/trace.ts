import type { TaskInspectInput } from '@reflexion-os-studio/contracts'
import type { ToolContext } from '../shared.js'

export function readDelegationTrace(
  ctx: ToolContext,
  sessionId: string,
  input: TaskInspectInput,
) {
  const messages = ctx.store.messages.listBySession(sessionId)
  const tools = ctx.store.toolCalls.listBySession(sessionId)
  const entries = [
    ...messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        id: message.id,
        kind: 'message',
        role: message.role,
        runId: message.runId,
        status: message.status,
        createdAt: message.createdAt,
        text: message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
      })),
    ...tools.map((tool) => ({
      id: tool.id,
      kind: 'tool',
      toolName: tool.toolName,
      runId: tool.runId,
      status: tool.status,
      createdAt: tool.createdAt,
      // Project canonical ToolOutput; never decode private tool JSON separately.
      text: JSON.stringify({
        args: tool.args,
        content: tool.output?.content ?? null,
        errorCode: tool.errorCode,
        changedFiles: tool.output?.changedFiles ?? [],
      }),
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const page = entries
    .slice(input.offset, input.offset + input.limit)
    .map((entry, index) => {
      const text = entry.text.slice(
        input.textOffset,
        input.textOffset + input.textLength,
      )
      return {
        ...entry,
        index: input.offset + index,
        text,
        textLength: entry.text.length,
        nextTextOffset:
          input.textOffset + text.length < entry.text.length
            ? input.textOffset + text.length
            : null,
      }
    })
  return {
    entries: page,
    nextOffset:
      input.offset + page.length < entries.length
        ? input.offset + page.length
        : null,
    total: entries.length,
    snapshot: true,
  }
}
