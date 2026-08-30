import type { ModelMessage } from './types.js'

/**
 * 长会话上下文压缩：token 估算 + 摘要压缩。
 * 摘要器由调用方注入（通常是携带压缩 prompt 的一次模型调用），
 * 本模块只负责"何时压、压哪段、压成什么样"，保持可测试。
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
  return messages.reduce(
    (total, message) => total + estimateTokens(message.content),
    0,
  )
}

export interface CompactOptions {
  messages: ModelMessage[]
  /** 上下文 token 预算；超过即触发压缩。 */
  budgetTokens: number
  /** 压缩时始终原样保留的最近消息条数（含工具结果）。 */
  keepRecent: number
  /** 注入的摘要器：把一段旧消息压缩为一条摘要文本。 */
  summarize(oldMessages: ModelMessage[]): Promise<string>
}

export interface CompactResult {
  messages: ModelMessage[]
  compacted: boolean
  summary: string | null
}

/**
 * 压缩策略：超出预算时，把 keepRecent 窗口之前的旧消息交给摘要器，
 * 生成一条 user 角色的"[历史摘要]"消息接在 system 之后。
 * messages[0] 约定为 system prompt，永不被压缩。
 */
export async function compactMessages(
  options: CompactOptions,
): Promise<CompactResult> {
  const { messages, budgetTokens, keepRecent } = options
  if (estimateMessageTokens(messages) <= budgetTokens) {
    return { messages, compacted: false, summary: null }
  }

  const system = messages[0]?.role === 'system' ? messages[0] : null
  const body = system !== null ? messages.slice(1) : messages
  const keep = Math.min(keepRecent, body.length)
  const oldMessages = body.slice(0, body.length - keep)
  const recentMessages = body.slice(body.length - keep)

  if (oldMessages.length === 0) {
    return { messages, compacted: false, summary: null }
  }

  const summary = await options.summarize(oldMessages)
  const summaryMessage: ModelMessage = {
    role: 'user',
    content: `[历史摘要]\n${summary}`,
  }
  const compactedMessages =
    system !== null
      ? [system, summaryMessage, ...recentMessages]
      : [summaryMessage, ...recentMessages]
  return { messages: compactedMessages, compacted: true, summary }
}
