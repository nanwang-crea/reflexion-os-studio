import type { ModelMessage } from './types.js'

/**
 * token 估算与诊断口径：CJK≈1 token/字，其余约 4 字符 1 token。
 * 压缩与裁剪本体在 frames.ts（Atomic Context Frames，工具轮不拆）。
 */

/** 粗略 token 估算：CJK 字符约 1 token/字，其他按 4 字符 1 token。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    // assistant 的工具调用参数(如 file.edit 的 content)可能很长,
    // 不计入会严重低估实际载荷。
    const toolArgs =
      message.role === 'assistant'
        ? message.toolCalls.reduce(
            (sum, call) => sum + estimateTokens(call.arguments),
            0,
          )
        : 0
    return total + estimateTokens(message.content) + toolArgs
  }, 0)
}
