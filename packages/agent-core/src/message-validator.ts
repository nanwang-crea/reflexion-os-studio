import type { ModelMessage } from './types.js'

export interface MessageValidationIssue {
  index: number
  detail: string
}

/**
 * Provider 请求前消息序列校验（每次发模型前强制执行）：
 * - 第一条可以是 system，后续不得再出现 system；
 * - assistant tool call id 全局唯一；
 * - tool result 必须引用已声明且尚未消费的 call id；
 * - 每个 call id 恰有一个 result；
 * - tool results 位于声明它们的 assistant 之后、下一个非 tool 消息之前；
 * - assistant 无空壳工具调用（有 toolCalls 数组即不得为空壳、id 非空）。
 * 返回空数组表示合法；宿主按 internal 失败处理（数据损坏不上 Provider）。
 */
export function validateModelMessages(
  messages: ModelMessage[],
): MessageValidationIssue[] {
  const issues: MessageValidationIssue[] = []
  let systemSeen = false
  const declared = new Set<string>()
  const consumed = new Set<string>()
  /** 当前仍可接收 results 的 call id 集合（遇到下一个非 tool 消息清空）。 */
  let pendingResults = new Set<string>()

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'system') {
      if (index > 0) {
        issues.push({ index, detail: 'system message after the first entry' })
      }
      if (systemSeen) {
        issues.push({ index, detail: 'duplicate system message' })
      }
      systemSeen = true
      continue
    }
    if (message.role === 'tool') {
      if (!declared.has(message.toolCallId)) {
        issues.push({
          index,
          detail: `tool result references undeclared call id ${message.toolCallId.slice(0, 12)}`,
        })
        continue
      }
      if (consumed.has(message.toolCallId)) {
        issues.push({
          index,
          detail: `duplicate result for call id ${message.toolCallId.slice(0, 12)}`,
        })
        continue
      }
      if (!pendingResults.has(message.toolCallId)) {
        issues.push({
          index,
          detail: `tool result for ${message.toolCallId.slice(0, 12)} is not adjacent to its declaring assistant message`,
        })
        continue
      }
      consumed.add(message.toolCallId)
      pendingResults.delete(message.toolCallId)
      continue
    }
    // user / assistant 消息都会关闭 pending 结果窗口。
    if (message.role === 'user' && pendingResults.size > 0) {
      issues.push({
        index,
        detail: `${pendingResults.size} tool result(s) missing before the next non-tool message`,
      })
      pendingResults = new Set()
      continue
    }
    if (message.role === 'assistant') {
      if (pendingResults.size > 0) {
        issues.push({
          index,
          detail: `${pendingResults.size} tool result(s) missing before the next assistant message`,
        })
        pendingResults = new Set()
      }
      for (const call of message.toolCalls) {
        if (call.id === '' || call.name === '') {
          issues.push({ index, detail: 'tool call with empty id or name' })
          continue
        }
        if (declared.has(call.id)) {
          issues.push({
            index,
            detail: `duplicate tool call id ${call.id.slice(0, 12)}`,
          })
          continue
        }
        declared.add(call.id)
        pendingResults.add(call.id)
      }
    }
  }
  if (pendingResults.size > 0) {
    issues.push({
      index: messages.length,
      detail: `sequence ends with ${pendingResults.size} tool call(s) missing results`,
    })
  }
  return issues
}
