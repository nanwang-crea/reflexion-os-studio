import {
  DEFAULT_MAX_TURNS,
  type AgentLoopOutcome,
  type AgentLoopOptions,
  type ModelMessage,
} from './types.js'

/** 失败反思阈值：工具调用累计失败达到该次数后，下一轮自动注入反思消息。 */
const DEFAULT_REFLECTION_THRESHOLD = 2

/** 反思消息：提示模型先总结失败原因再调整策略，避免盲目重试。 */
function buildReflectionMessage(failedTools: string[]): string {
  const names = [...new Set(failedTools)].join('、')
  return `[反思] 最近的 ${failedTools.length} 次工具调用失败（${names}）。请先分析失败原因（参数、权限、超时等），在下一步给出修正策略，不要盲目重试同样的操作。`
}

/**
 * Agent 主循环：模型调用 → 工具调用 → 结果回填 → 继续调用，
 * 直到模型不再请求工具（任务完成）或达到轮次上限。
 * 循环只编排消息流；持久化、事件通知与方言投影全部由注入的回调承担。
 * 工具失败达到阈值时向模型注入反思消息（Reflexion 机制），失败记录随注入重置。
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopOutcome> {
  const { history, signal } = options
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const reflectionThreshold =
    options.reflectionThreshold ?? DEFAULT_REFLECTION_THRESHOLD
  const messages: ModelMessage[] = [...history]
  let turns = 0
  let failuresSinceReflection = 0
  let failedToolNames: string[] = []

  while (turns < maxTurns) {
    if (signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    if (
      reflectionThreshold > 0 &&
      failuresSinceReflection >= reflectionThreshold
    ) {
      messages.push({
        role: 'user',
        content: buildReflectionMessage(failedToolNames),
      })
      failuresSinceReflection = 0
      failedToolNames = []
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

    // 同轮多个工具调用并行执行（与主流 Agent 一致），结果按调用顺序回填，
    // 保证回传给模型的 role=tool 消息与 tool_calls 一一对应、顺序稳定。
    const results = await Promise.all(
      turn.toolCalls.map(async (call) => {
        if (signal.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        await options.onEvent?.({ type: 'tool.started', call })
        const result = await options.executeTool(call, signal)
        await options.onEvent?.({ type: 'tool.finished', call, result })
        return { call, result }
      }),
    )
    for (const { call, result } of results) {
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: result.content,
        isError: result.isError,
      })
      if (result.isError) {
        failuresSinceReflection += 1
        failedToolNames.push(call.name)
      }
    }
  }

  return {
    status: 'max_turns_exhausted',
    turns,
    finalTurn: null,
    messages,
  }
}
