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

/**
 * 轮内消息预算约束（不额外调用模型）：超预算时优先折叠最老的
 * "assistant 工具轮 + 其 tool 结果"为一句话（成对删除，保证 provider
 * 对 tool_call_id 的配对要求），全部折叠完仍超则退化为最近窗口截断。
 * 返回的新数组可安全发给 provider；原数组不被修改。
 */
export function boundMessagesForModel(
  messages: ModelMessage[],
  budgetTokens: number,
): ModelMessage[] {
  let current = [...messages]
  if (estimateMessageTokens(current) <= budgetTokens) return current
  let folded = foldOldestToolRound(current)
  while (folded !== null) {
    current = folded
    if (estimateMessageTokens(current) <= budgetTokens) return current
    folded = foldOldestToolRound(current)
  }
  // 截断兜底：此时已无任何工具轮引用，截断不会造成悬空 tool_call_id。
  const system = current[0]?.role === 'system' ? current[0] : null
  const body = system !== null ? current.slice(1) : current
  const bounded: ModelMessage[] = [
    ...(system !== null ? [system] : []),
    { role: 'user', content: '[更早的历史已因上下文超长被截断]' },
    ...body.slice(Math.max(0, body.length - KEEP_RECENT)),
  ]
  // 最终手段（窗口内单条消息本身超预算，如粘贴巨文）：每次收缩当前最长的
  // 非 system 消息内容（几何收敛最快），直到满足预算或无法再缩。
  let shrinkPasses = 0
  while (estimateMessageTokens(bounded) > budgetTokens && shrinkPasses < 48) {
    shrinkPasses += 1
    let targetIndex = -1
    let targetLength = 0
    for (let i = 1; i < bounded.length; i += 1) {
      const message = bounded[i]
      if (message.role === 'system') continue
      if (message.content.length > targetLength) {
        targetIndex = i
        targetLength = message.content.length
      }
    }
    if (targetIndex < 0 || targetLength < 32) break
    const message = bounded[targetIndex]
    bounded[targetIndex] = {
      ...message,
      content: `${message.content.slice(0, Math.floor(targetLength / 2))}…（因上下文超长被截断）`,
    }
  }
  return bounded
}

/** 截断兜底时保留的最近消息条数。 */
const KEEP_RECENT = 12

/**
 * 折叠最老的一对工具轮：assistant 的 toolCalls 置空并追加省略说明，
 * 其对应的 role=tool 结果消息全部删除。找不到可折叠对返回 null。
 */
function foldOldestToolRound(messages: ModelMessage[]): ModelMessage[] | null {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message.role !== 'assistant' || message.toolCalls.length === 0) {
      continue
    }
    const ids = new Set(message.toolCalls.map((call) => call.id))
    const kept: ModelMessage[] = []
    let folded = false
    for (let j = 0; j < messages.length; j += 1) {
      const current = messages[j]
      if (j > i && current.role === 'tool' && ids.has(current.toolCallId)) {
        folded = true
        continue
      }
      kept.push(current)
    }
    const prefix = message.content === '' ? '' : `${message.content}\n`
    kept[i] = {
      role: 'assistant',
      content: `${prefix}[此前的 ${message.toolCalls.length} 个工具调用及其结果已因上下文过长省略]`,
      toolCalls: [],
    }
    return folded ? kept : null
  }
  return null
}
