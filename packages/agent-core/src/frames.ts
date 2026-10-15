import type { ModelMessage } from './types.js'
export {
  FrameError,
  framesToMessages,
  messagesToFrames,
} from './context/projection.js'
export { estimateFrameTokens } from './context/estimate.js'
export { compactFrames, boundFramesForModel } from './context/bounds.js'
export { estimateMessageTokens } from './context.js'

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
  images?: Extract<ModelMessage, { role: 'user' }>['images']
}

export interface AssistantTextFrame {
  kind: 'assistant_text'
  content: string
  reasoning?: string
  providerContinuation?: Extract<
    ModelMessage,
    { role: 'assistant' }
  >['providerContinuation']
}

export interface ToolRoundFrame {
  kind: 'tool_round'
  assistant: Extract<ModelMessage, { role: 'assistant' }>
  /** 与 assistant.toolCalls 一一对应（顺序一致、数量相等）。 */
  results: Extract<ModelMessage, { role: 'tool' }>[]
}

export interface RuntimeControlFrame {
  kind: 'runtime_control'
  control?: Extract<ModelMessage, { role: 'user' }>['control']
  content: string
}

export type ContextFrame =
  | SystemFrame
  | UserFrame
  | AssistantTextFrame
  | ToolRoundFrame
  | RuntimeControlFrame
