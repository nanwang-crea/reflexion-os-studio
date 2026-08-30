import {
  DEFAULT_MAX_TURNS,
  type AgentLoopOutcome,
  type AgentLoopOptions,
  type ModelMessage,
  type ModelTurn,
} from './types.js'

/**
 * Agent 主循环：模型调用 → 工具调用 → 结果回填 → 继续调用，
 * 直到模型不再请求工具（任务完成）或达到轮次上限。
 * 循环只编排消息流；持久化、事件通知与方言投影全部由注入的回调承担。
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopOutcome> {
  const { history, signal } = options
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const messages: ModelMessage[] = [...history]
  let turns = 0

  while (turns < maxTurns) {
    if (signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const turn = await options.callModel(messages, signal)
    turns += 1

    if (turn.toolCalls.length === 0) {
      return { status: 'completed', turns, finalTurn: turn, messages }
    }

    messages.push({
      role: 'assistant',
      content: turn.content,
      toolCalls: turn.toolCalls,
    })
    await options.onEvent?.({ type: 'assistant.turn', index: turns, turn })

    for (const call of turn.toolCalls) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      await options.onEvent?.({ type: 'tool.started', call })
      const result = await options.executeTool(call, signal)
      await options.onEvent?.({ type: 'tool.finished', call, result })
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: result.content,
        isError: result.isError,
      })
    }
  }

  return {
    status: 'max_turns_exhausted',
    turns,
    finalTurn: null,
    messages,
  }
}
