import type {
  AssistantToolCall,
  ModelMessage,
} from '@reflexion-os-studio/agent-core'
import {
  compactMessages,
  estimateMessageTokens,
} from '@reflexion-os-studio/agent-core'
import type { ToolCall } from '@reflexion-os-studio/contracts'
import type { Store } from '../store/index.js'
import { streamChatCompletion } from '../provider.js'
import { buildMemoryBlock } from './memory/recall.js'
import { HISTORY_COMPACTOR_SYSTEM_PROMPT } from './prompts/index.js'
import { capToolResultForModel } from './toolResults.js'

/**
 * 上下文 token 预算：超过即触发摘要压缩。
 * A2 接入模型元数据（contextWindow）后按所选模型动态取值。
 */
export const CONTEXT_TOKEN_BUDGET = 24_000

/** 压缩时始终原样保留的最近消息条数（含工具结果轮次）。 */
const KEEP_RECENT_MESSAGES = 12

export interface ProviderRuntimeConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 会话历史的重建与压缩；Run 启动时由 runner 调用一次。 */
export class ContextBuilder {
  constructor(private readonly store: Store) {}

  /**
   * 从 canonical 存储重建会话历史（system + 记忆块 → 摘要 → 最近轮次），
   * 超出预算时用压缩 prompt 做一次静默摘要调用；摘要失败则退化为截断，不阻塞对话。
   */
  async build(
    sessionId: string,
    systemPrompt: string,
    provider: ProviderRuntimeConfig,
    signal: AbortSignal,
  ): Promise<ModelMessage[]> {
    // A2 Memory 召回：失败/为空都不影响对话，只是没有记忆块。
    const memoryBlock = await buildMemoryBlock(this.store, sessionId).catch(
      () => '',
    )
    const effectiveSystem =
      memoryBlock === '' ? systemPrompt : `${systemPrompt}\n\n${memoryBlock}`
    const history = this.reconstruct(sessionId, effectiveSystem)
    try {
      const { messages } = await compactMessages({
        messages: history,
        budgetTokens: CONTEXT_TOKEN_BUDGET,
        keepRecent: KEEP_RECENT_MESSAGES,
        summarize: (oldMessages) =>
          this.summarize(oldMessages, provider, signal),
      })
      return messages
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      // 压缩失败（网络/Provider 异常）不拦任务：退化为保留 system + 最近窗口。
      process.stderr.write(
        `[runtime] context compaction failed, falling back to truncation: ${String(error)}\n`,
      )
      return truncateToRecent(history, KEEP_RECENT_MESSAGES)
    }
  }

  /** 当前历史的 token 估算，暴露给诊断与未来预算策略。 */
  estimate(sessionId: string, systemPrompt: string): number {
    return estimateMessageTokens(this.reconstruct(sessionId, systemPrompt))
  }

  private reconstruct(sessionId: string, systemPrompt: string): ModelMessage[] {
    const messages: ModelMessage[] = [{ role: 'system', content: systemPrompt }]
    for (const message of this.store.messages.listBySession(sessionId)) {
      if (message.role === 'system') continue
      const text = message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      if (message.role === 'user') {
        if (text !== '') messages.push({ role: 'user', content: text })
        continue
      }
      if (message.role !== 'assistant' || message.status !== 'completed') {
        continue
      }
      const toolCallRows = this.store.toolCalls.listByMessage(message.id)
      if (toolCallRows.length === 0) {
        if (text === '') continue
        messages.push({ role: 'assistant', content: text, toolCalls: [] })
        continue
      }
      // 工具轮次：assistant.toolCalls 与 role=tool 结果按 row id 重建，
      // 保证跨 Run 恢复会话时方言一致（live 轮次用 Provider 侧 id，落库后统一为本表 id）。
      messages.push({
        role: 'assistant',
        content: text,
        toolCalls: toolCallRows.map(toAssistantToolCall),
      })
      for (const row of toolCallRows) {
        messages.push({
          role: 'tool',
          toolCallId: row.id,
          content: toolResultText(row),
          isError: row.status !== 'completed',
        })
      }
    }
    return messages
  }

  private async summarize(
    oldMessages: ModelMessage[],
    provider: ProviderRuntimeConfig,
    signal: AbortSignal,
  ): Promise<string> {
    const transcript = oldMessages
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n')
    const result = await streamChatCompletion(
      {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        messages: [
          { role: 'system', content: HISTORY_COMPACTOR_SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
        signal,
        timeoutMs: 60_000,
      },
      () => {},
    )
    return result.content
  }
}

function toAssistantToolCall(row: ToolCall): AssistantToolCall {
  return {
    id: row.id,
    name: row.toolName,
    arguments: JSON.stringify(row.args ?? {}),
  }
}

function toolResultText(row: ToolCall): string {
  if (row.status === 'completed') {
    // 历史重建与实时回填保持同一截断边界，避免重启前后上下文口径不一致。
    return capToolResultForModel(JSON.stringify(row.result ?? null))
  }
  return `工具执行失败${row.errorCode ? `（${row.errorCode}）` : ''}`
}

function truncateToRecent(
  messages: ModelMessage[],
  keepRecent: number,
): ModelMessage[] {
  const system = messages[0]?.role === 'system' ? messages[0] : null
  const body = system !== null ? messages.slice(1) : messages
  const recent = body.slice(Math.max(0, body.length - keepRecent))
  const notice: ModelMessage = {
    role: 'user',
    content: '[更早的历史已因上下文超长被截断]',
  }
  return system !== null ? [system, notice, ...recent] : [notice, ...recent]
}
