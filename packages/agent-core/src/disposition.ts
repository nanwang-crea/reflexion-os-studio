import type {
  AssistantToolCall,
  ModelFinishReason,
  ModelTurnDisposition,
} from './types.js'

/**
 * Provider 协议违规：finish reason 缺失/未知、reason 与 toolCalls 不一致、
 * 工具调用形状不完整。由循环抛出，宿主统一收敛为 failed + provider_protocol。
 */
export class ModelProtocolError extends Error {
  constructor(detail: string) {
    super(`provider protocol violation: ${detail}`)
    this.name = 'ModelProtocolError'
  }
}

/**
 * 完成状态机：把"finish reason + tool calls"映射为唯一的轮次判定。
 * 缺失/未知 reason、reason 与 toolCalls 不一致均为 protocol_error，
 * 不静默假成功；工具调用完整性要求 id/name 非空、arguments 为合法 JSON。
 */
export function classifyModelTurn(
  finishReason: ModelFinishReason,
  toolCalls: AssistantToolCall[],
): ModelTurnDisposition {
  const hasToolCalls = toolCalls.length > 0
  switch (finishReason) {
    case 'stop':
      if (hasToolCalls) {
        return {
          kind: 'protocol_error',
          detail: `finish_reason=stop but ${toolCalls.length} tool calls present`,
        }
      }
      return { kind: 'final' }
    case 'tool_calls': {
      if (!hasToolCalls) {
        return {
          kind: 'protocol_error',
          detail: 'finish_reason=tool_calls but no tool calls present',
        }
      }
      const incomplete = validateToolCallShape(toolCalls)
      if (incomplete !== null) return incomplete
      return { kind: 'tools' }
    }
    case 'length':
      if (hasToolCalls) {
        return {
          kind: 'protocol_error',
          detail: `finish_reason=length with ${toolCalls.length} tool calls is not continuable`,
        }
      }
      return { kind: 'truncated' }
    case 'content_filter':
      if (hasToolCalls) {
        return {
          kind: 'protocol_error',
          detail: `finish_reason=content_filter with ${toolCalls.length} tool calls`,
        }
      }
      return { kind: 'blocked', reason: 'content_filtered' }
  }
}

/**
 * 判定并断言协议合法：protocol_error 直接抛 ModelProtocolError。
 * 循环与宿主的模型轮持久化层共用，保证判定口径一致。
 */
export function requireModelTurnDisposition(
  finishReason: ModelFinishReason,
  toolCalls: AssistantToolCall[],
): Exclude<ModelTurnDisposition, { kind: 'protocol_error'; detail: string }> {
  const disposition = classifyModelTurn(finishReason, toolCalls)
  if (disposition.kind === 'protocol_error') {
    throw new ModelProtocolError(disposition.detail)
  }
  return disposition
}

/** 工具调用形状校验：id/name 非空、arguments 是完整 JSON、id 同轮唯一。 */
function validateToolCallShape(
  toolCalls: AssistantToolCall[],
): ModelTurnDisposition | null {
  const seenIds = new Set<string>()
  for (const call of toolCalls) {
    if (call.id === '' || call.name === '') {
      return {
        kind: 'protocol_error',
        detail: 'tool call has empty id or name',
      }
    }
    if (seenIds.has(call.id)) {
      return {
        kind: 'protocol_error',
        detail: `duplicate tool call id: ${call.id.slice(0, 8)}`,
      }
    }
    seenIds.add(call.id)
    if (call.arguments.trim() !== '' && !isCompleteJson(call.arguments)) {
      return {
        kind: 'protocol_error',
        detail: `tool call ${call.name} has incomplete JSON arguments`,
      }
    }
  }
  return null
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
