import type { ModelMessage } from './types.js'
import { estimateMessageTokens, estimateTokens } from './context.js'

/**
 * Atomic Context Frames：Provider 无关的原子上下文单元。
 * assistant tool calls 与其全部 tool results 不可拆分（ToolRoundFrame），
 * 所有压缩、保留最近窗口、token 估算与兜底裁剪只处理 Frame，
 * 杜绝按消息下标切割造成的悬空/重复 tool result。
 */

export interface SystemFrame {
  kind: 'system'
  content: string
}

export interface UserFrame {
  kind: 'user'
  content: string
}

export interface AssistantTextFrame {
  kind: 'assistant_text'
  content: string
}

export interface ToolRoundFrame {
  kind: 'tool_round'
  assistant: Extract<ModelMessage, { role: 'assistant' }>
  /** 与 assistant.toolCalls 一一对应（顺序一致、数量相等）。 */
  results: Extract<ModelMessage, { role: 'tool' }>[]
}

export interface RuntimeControlFrame {
  kind: 'runtime_control'
  content: string
}

export type ContextFrame =
  | SystemFrame
  | UserFrame
  | AssistantTextFrame
  | ToolRoundFrame
  | RuntimeControlFrame

/** Frame → Provider 消息投影；ToolRoundFrame 展开为 assistant + 全部 results。 */
export function framesToMessages(frames: ContextFrame[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const frame of frames) {
    switch (frame.kind) {
      case 'system':
        messages.push({ role: 'system', content: frame.content })
        break
      case 'user':
        messages.push({ role: 'user', content: frame.content })
        break
      case 'assistant_text':
        messages.push({
          role: 'assistant',
          content: frame.content,
          toolCalls: [],
        })
        break
      case 'tool_round':
        messages.push(frame.assistant)
        messages.push(...frame.results)
        break
      case 'runtime_control':
        messages.push({ role: 'user', content: frame.content })
        break
    }
  }
  return messages
}

/** Frame 级 token 估算：工具轮计入 arguments 与全部结果文本。 */
export function estimateFrameTokens(frames: ContextFrame[]): number {
  let total = 0
  for (const frame of frames) {
    switch (frame.kind) {
      case 'system':
      case 'user':
      case 'assistant_text':
      case 'runtime_control':
        total += estimateTokens(frame.content)
        break
      case 'tool_round': {
        total += estimateTokens(frame.assistant.content)
        for (const call of frame.assistant.toolCalls) {
          total += estimateTokens(call.arguments)
        }
        for (const result of frame.results) {
          total += estimateTokens(result.content)
        }
        break
      }
    }
  }
  return total
}

/** 消息序列 → Frame：本地数据损坏（悬空结果/重复 call id）抛 FrameError。 */
export function messagesToFrames(messages: ModelMessage[]): ContextFrame[] {
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
      frames.push({ kind: 'assistant_text', content: message.content })
      continue
    }
    if (message.role === 'system') {
      frames.push({ kind: 'system', content: message.content })
      continue
    }
    frames.push({ kind: 'user', content: message.content })
  }
  // 悬空声明：assistant 声明了 tool call 但没有对应 result。
  for (const [callId, index] of openCalls) {
    if (!consumed.has(callId)) {
      const frame = frames[index]
      if (frame.kind === 'tool_round' && frame.results.length === 0) {
        throw new FrameError(
          `tool call declared without any result: ${callId.slice(0, 12)}`,
        )
      }
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

/**
 * 把"稳定旧 Frame"折叠为一条摘要消息（Frame 边界切割，不拆工具轮）。
 * 返回投影后的消息序列：system + 摘要 + 保留的最近 Frame。
 */
export async function compactFrames(options: {
  frames: ContextFrame[]
  budgetTokens: number
  /** 始终原样保留的最近 Frame 数（工具轮整体计一）。 */
  keepRecentFrames: number
  summarize(stableFrames: ContextFrame[]): Promise<string>
}): Promise<{
  frames: ContextFrame[]
  compacted: boolean
  summary: string | null
}> {
  const { frames, budgetTokens, keepRecentFrames } = options
  if (estimateFrameTokens(frames) <= budgetTokens) {
    return { frames, compacted: false, summary: null }
  }
  const head = frames[0]?.kind === 'system' ? 1 : 0
  const system = head === 1 ? frames[0] : null
  const body = frames.slice(head)
  const keep = Math.min(keepRecentFrames, body.length)
  const stable = body.slice(0, body.length - keep)
  const recent = body.slice(body.length - keep)
  if (stable.length === 0) {
    return { frames, compacted: false, summary: null }
  }
  const summary = await options.summarize(stable)
  const summaryFrame: ContextFrame = {
    kind: 'user',
    content: `[历史摘要]\n${summary}`,
  }
  const compacted = [...(system ? [system] : []), summaryFrame, ...recent]
  return { frames: compacted, compacted: true, summary }
}

/**
 * 轮内 Frame 兜底裁剪：按 Frame 从最旧开始折叠（工具轮整体折叠为说明文本），
 * 全部折叠完仍超预算则截断到最近窗口。不产生悬空 tool result。
 */
export function boundFramesForModel(
  frames: ContextFrame[],
  budgetTokens: number,
  keepRecentFrames = 8,
): ContextFrame[] {
  let current = [...frames]
  if (estimateFrameTokens(current) <= budgetTokens) return current
  let folded = foldOldestToolRoundFrame(current)
  while (folded !== null) {
    current = folded
    if (estimateFrameTokens(current) <= budgetTokens) return current
    folded = foldOldestToolRoundFrame(current)
  }
  // 截断兜底：保留 system + 最近 Frame 窗口。
  const head = current[0]?.kind === 'system' ? 1 : 0
  const system = head === 1 ? current[0] : null
  const body = current.slice(head)
  const keep = Math.min(keepRecentFrames, body.length)
  const bounded: ContextFrame[] = [
    ...(system ? [system] : []),
    { kind: 'user', content: '[更早的历史已因上下文超长被截断]' },
    ...body.slice(body.length - keep),
  ]
  // 窗口内单 Frame 仍超预算（如粘贴巨文）：收缩最大非 system Frame。
  let shrinkPasses = 0
  while (estimateFrameTokens(bounded) > budgetTokens && shrinkPasses < 48) {
    shrinkPasses += 1
    const index = largestShrinkableIndex(bounded)
    if (index < 0) break
    const frame = bounded[index]
    const text =
      frame.kind === 'system' ||
      frame.kind === 'user' ||
      frame.kind === 'assistant_text' ||
      frame.kind === 'runtime_control'
        ? frame.content
        : frame.assistant.content
    if (text.length < 32) break
    const half = text.slice(0, Math.floor(text.length / 2))
    const truncated = `${half}…（因上下文超长被截断）`
    if (frame.kind === 'tool_round') {
      bounded[index] = {
        ...frame,
        assistant: { ...frame.assistant, content: truncated },
      }
    } else {
      bounded[index] = { ...frame, content: truncated } as ContextFrame
    }
  }
  return bounded
}

/** 折叠最老的工具轮 Frame 为说明性 assistant 文本；无可折叠返回 null。 */
function foldOldestToolRoundFrame(
  frames: ContextFrame[],
): ContextFrame[] | null {
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]
    if (frame.kind !== 'tool_round') continue
    const prefix =
      frame.assistant.content === '' ? '' : `${frame.assistant.content}\n`
    const folded: ContextFrame = {
      kind: 'assistant_text',
      content: `${prefix}[此前的 ${frame.assistant.toolCalls.length} 个工具调用及其结果已因上下文过长省略]`,
    }
    const kept = [...frames]
    kept.splice(i, 1, folded)
    return kept
  }
  return null
}

function largestShrinkableIndex(frames: ContextFrame[]): number {
  let index = -1
  let length = 0
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]
    if (frame.kind === 'system') continue
    const text =
      frame.kind === 'tool_round' ? frame.assistant.content : frame.content
    if (text.length > length) {
      index = i
      length = text.length
    }
  }
  return index
}

// 供按消息估算的旧接口兼容使用（诊断口径）。
export { estimateMessageTokens }
