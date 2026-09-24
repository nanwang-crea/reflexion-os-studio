import type {
  Message,
  Run,
  ToolCall,
} from '@reflexion-os-studio/runtime-client'
import type { ProcessItem } from './run/RunProcess'

export type ChatBlock =
  | { kind: 'plain'; item: ProcessItem }
  | {
      kind: 'run'
      runId: string
      processItems: ProcessItem[]
      finalItem: ProcessItem | null
    }

export function computeRunDurationMs(
  run: Run | null,
  message: Message,
): number | null {
  const startedAt = run?.startedAt ?? message.createdAt
  const completedAt = run?.completedAt ?? message.completedAt
  if (startedAt === null || completedAt === null) return null
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
  return end - start
}

export function isLastEditableUserMessage(
  message: Message,
  messages: Message[],
  runActive: boolean,
): boolean {
  if (message.role !== 'user') return false
  if (message.status === 'superseded' || runActive) return false
  const userMessages = messages.filter(
    (item) => item.role === 'user' && item.status !== 'superseded',
  )
  return userMessages.at(-1)?.id === message.id
}

/** 按 Run 分组：过程轮次进入一个整体折叠块，最后无工具轮作为最终回复。 */
export function buildChatBlocks(
  messages: Message[],
  toolCallsByMessage: Map<string, ToolCall[]>,
): ChatBlock[] {
  const blocks: ChatBlock[] = []
  let runId: string | null = null
  let runMessages: ProcessItem[] = []

  const flushRun = (): void => {
    if (runId === null || runMessages.length === 0) return
    let finalIndex = -1
    for (let index = runMessages.length - 1; index >= 0; index -= 1) {
      if (runMessages[index].toolCalls.length === 0) {
        finalIndex = index
        break
      }
    }
    blocks.push({
      kind: 'run',
      runId,
      processItems:
        finalIndex >= 0
          ? runMessages.filter((_, index) => index !== finalIndex)
          : runMessages,
      finalItem: finalIndex >= 0 ? runMessages[finalIndex] : null,
    })
    runId = null
    runMessages = []
  }

  for (const message of messages) {
    if (message.role === 'assistant' && message.runId !== null) {
      if (runId !== null && runId !== message.runId) flushRun()
      runId = message.runId
      runMessages.push({
        message,
        toolCalls: toolCallsByMessage.get(message.id) ?? [],
      })
      continue
    }
    flushRun()
    blocks.push({
      kind: 'plain',
      item: { message, toolCalls: toolCallsByMessage.get(message.id) ?? [] },
    })
  }
  flushRun()
  return blocks
}
