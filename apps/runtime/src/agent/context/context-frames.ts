import { filePartsText } from './file-parts.js'
import { toolImageParts } from './tool-images.js'
import {
  FrameError,
  framesToMessages,
  type AssistantToolCall,
  type ContextFrame,
  type ModelMessage,
  validateModelMessages,
} from '@reflexion-os-studio/agent-core'
import type { ToolCall } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { capToolResultForModel } from '../run/toolResults.js'

/**
 * DB → Atomic Context Frames 重建：从 canonical 存储按稳定顺序构建 Frame。
 * assistant tool calls 与其全部 tool results 一次生成一个 ToolRoundFrame；
 * cancelled/failed 的 ToolCall 也生成 error result，保证历史可重放。
 * 本地数据损坏（悬空结果/重复 id）抛 FrameError，由调用方收敛为 internal。
 */

/** 参与有效历史的 assistant 消息状态。 */
const VALID_ASSISTANT_STATUSES = new Set(['completed', 'failed', 'interrupted'])

/**
 * 重建 Frame 并行携带来源消息 id（watermark 用）：
 * system 帧为 null；user/assistant 文本帧为消息 id；工具轮为 assistant 消息 id。
 */
export function reconstructSessionFramesWithIds(
  store: Store,
  sessionId: string,
  systemPrompt: string,
  window?: { after?: string; through?: string },
): { frames: ContextFrame[]; messageIds: (string | null)[] } {
  const frames: ContextFrame[] = [{ kind: 'system', content: systemPrompt }]
  const messageIds: (string | null)[] = [null]
  const messages = window
    ? store.messages.listWindow(sessionId, window.after, window.through)
    : store.messages.listBySession(sessionId)
  const calls = new Map<string, ToolCall[]>()
  for (const call of store.toolCalls.listByMessages(
    messages.map((message) => message.id),
  )) {
    if (call.messageId) {
      const group = calls.get(call.messageId) ?? []
      group.push(call)
      calls.set(call.messageId, group)
    }
  }
  for (const message of messages) {
    if (message.role === 'system') continue
    const text =
      message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('') +
      (message.role === 'user' ? filePartsText(message.parts) : '')
    if (message.role === 'user') {
      const images = message.parts.filter((part) => part.type === 'image')
      if (text !== '' || images.length > 0) {
        frames.push({
          kind: 'user',
          content: text,
          ...(images.length ? { images } : {}),
        })
        messageIds.push(message.id)
      }
      continue
    }
    if (
      message.role !== 'assistant' ||
      !VALID_ASSISTANT_STATUSES.has(message.status)
    ) {
      continue
    }
    const toolCallRows = calls.get(message.id) ?? []
    if (toolCallRows.length === 0) {
      // 非完成的纯文本 assistant（interrupted/failed）不回放正文。
      if (
        message.status !== 'completed' ||
        (text === '' && !message.reasoning && !message.providerContinuation)
      )
        continue
      frames.push({
        kind: 'assistant_text',
        content: text,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.providerContinuation
          ? { providerContinuation: message.providerContinuation }
          : {}),
      })
      messageIds.push(message.id)
      continue
    }
    // 工具轮次：assistant.toolCalls 与全部 results 一次生成（不可拆分）。
    // interrupted/failed 轮的正文保留（已有内容是事实），results 照常生成。
    frames.push({
      kind: 'tool_round',
      assistant: {
        role: 'assistant',
        content: text,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.providerContinuation
          ? { providerContinuation: message.providerContinuation }
          : {}),
        toolCalls: toolCallRows.map(toAssistantToolCall),
      },
      results: toolCallRows.map((row) => {
        const images = row.output
          ? toolImageParts(
              store,
              sessionId,
              row.runId,
              row.toolName,
              row.output,
            )
          : []
        return {
          role: 'tool' as const,
          toolCallId: row.id,
          content: toolResultText(row),
          isError: row.status !== 'completed',
          ...(images.length ? { images } : {}),
        }
      }),
    })
    messageIds.push(message.id)
  }
  return { frames, messageIds }
}

export function reconstructSessionFrames(
  store: Store,
  sessionId: string,
  systemPrompt: string,
): ContextFrame[] {
  return reconstructSessionFramesWithIds(store, sessionId, systemPrompt).frames
}

/** framesToMessages + 序列校验：损坏数据在发 Provider 前失败。 */
export function framesToValidatedMessages(
  frames: ContextFrame[],
): ModelMessage[] {
  const messages = framesToMessages(frames)
  const issues = validateModelMessages(messages)
  if (issues.length > 0) {
    const first = issues[0]
    throw new FrameError(
      `canonical history corrupted (${issues.length} issue(s)); first: message#${first.index}: ${first.detail}`,
    )
  }
  return messages
}

function toAssistantToolCall(row: ToolCall): AssistantToolCall {
  return {
    id: row.id,
    name: row.toolName,
    arguments: JSON.stringify(row.args ?? {}),
  }
}

function toolResultText(row: ToolCall): string {
  if (row.output !== null) {
    // 历史重建与实时回填保持同一正文和截断边界，失败结果也不再丢失。
    return capToolResultForModel(row.output.content)
  }
  return row.status === 'completed'
    ? 'null'
    : `工具执行失败${row.errorCode ? `（${row.errorCode}）` : ''}`
}
