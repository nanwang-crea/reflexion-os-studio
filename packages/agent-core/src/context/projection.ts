import type { ContextFrame } from '../frames.js'
import type { ModelMessage } from '../types.js'
import { validateModelMessages } from '../message-validator.js'

/** Frame → Provider 消息投影；ToolRoundFrame 展开为 assistant + 全部 results。 */
export function framesToMessages(frames: ContextFrame[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const frame of frames) {
    switch (frame.kind) {
      case 'system':
        messages.push({ role: 'system', content: frame.content })
        break
      case 'user':
        messages.push({
          role: 'user',
          content: frame.content,
          ...('images' in frame && frame.images?.length
            ? { images: frame.images }
            : {}),
        })
        break
      case 'assistant_text':
        messages.push({
          role: 'assistant',
          content: frame.content,
          ...(frame.reasoning ? { reasoning: frame.reasoning } : {}),
          ...(frame.providerContinuation
            ? { providerContinuation: frame.providerContinuation }
            : {}),
          toolCalls: [],
        })
        break
      case 'tool_round':
        messages.push(frame.assistant)
        messages.push(...frame.results)
        break
      case 'runtime_control':
        messages.push({
          role: 'user',
          content: frame.content,
          ...(frame.control ? { control: frame.control } : {}),
        })
        break
    }
  }
  return messages
}

/** 消息序列 → Frame：本地数据损坏（悬空结果/重复 call id）抛 FrameError。 */
export function messagesToFrames(messages: ModelMessage[]): ContextFrame[] {
  const issues = validateModelMessages(messages)
  if (issues.length) throw new FrameError(issues[0].detail)
  const frames: ContextFrame[] = []
  const openCalls = new Map<string, number>()
  const consumed = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      const frameIndex = openCalls.get(message.toolCallId)
      if (frameIndex === undefined || consumed.has(message.toolCallId)) {
        throw new FrameError(
          `tool result references unknown or already-consumed call id: ${message.toolCallId.slice(0, 12)}`,
        )
      }
      const frame = frames[frameIndex]
      if (frame.kind !== 'tool_round') continue
      frame.results.push(message)
      consumed.add(message.toolCallId)
      continue
    }
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      for (const call of message.toolCalls) {
        if (openCalls.has(call.id) && !consumed.has(call.id)) {
          throw new FrameError(
            `assistant re-declares an unresolved tool call id: ${call.id.slice(0, 12)}`,
          )
        }
        openCalls.set(call.id, frames.length)
      }
      frames.push({ kind: 'tool_round', assistant: message, results: [] })
      continue
    }
    if (message.role === 'assistant') {
      frames.push({
        kind: 'assistant_text',
        content: message.content,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.providerContinuation
          ? { providerContinuation: message.providerContinuation }
          : {}),
      })
      continue
    }
    if (message.role === 'system') {
      frames.push({ kind: 'system', content: message.content })
      continue
    }
    if (message.control) {
      frames.push({
        kind: 'runtime_control',
        control: message.control,
        content: message.content,
      })
      continue
    }
    frames.push({
      kind: 'user',
      content: message.content,
      ...(message.images?.length ? { images: message.images } : {}),
    })
  }
  // 悬空声明：assistant 声明了 tool call 但没有对应 result。
  for (const callId of openCalls.keys()) {
    if (!consumed.has(callId)) {
      throw new FrameError(
        `tool call declared without a result: ${callId.slice(0, 12)}`,
      )
    }
  }
  return frames
}

/** 本地 canonical 数据损坏：不发送 Provider，由宿主收敛为 internal 失败。 */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}
