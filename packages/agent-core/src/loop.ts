import {
  DEFAULT_MAX_CONTINUATION_TURNS,
  DEFAULT_MAX_TURNS,
  type AgentLoopOutcome,
  type AgentLoopOptions,
  type ModelMessage,
} from './types.js'
import { requireModelTurnDisposition } from './disposition.js'

/** 失败反思阈值：工具调用累计失败达到该次数后，下一轮自动注入反思消息。 */
const DEFAULT_REFLECTION_THRESHOLD = 2

/** 反思消息：提示模型先总结失败原因再调整策略，避免盲目重试。 */
function buildReflectionMessage(failedTools: string[]): string {
  const names = [...new Set(failedTools)].join('、')
  return `[反思] 最近的 ${failedTools.length} 次工具调用失败（${names}）。请先分析失败原因（参数、权限、超时等），在下一步给出修正策略，不要盲目重试同样的操作。`
}

/** length 续写控制帧：仅存在于当前 Run 的内存消息流，不落库。 */
function buildContinuationMessage(): ModelMessage {
  return {
    role: 'user',
    content:
      '[续写] 上一条回复因长度限制被截断。请从截断点继续输出，不要重复已有内容，也不要重新开始；完成后正常结束。',
  }
}

/**
 * Agent 主循环：模型调用 → 状态机判定 → 工具调用 → 结果回填 → 继续调用。
 * 只有 finish_reason=stop 且无工具调用的轮次才算任务完成；
 * length 在续写预算内继续，content_filter/provider 协议违规/轮次耗尽
 * 以稳定 stopReason 失败。取消仍以 AbortError 传播。
 * 循环只编排消息流；持久化、事件通知与方言投影全部由注入的
 * callModel/executeTool 回调承担。工具失败达到阈值时向模型注入反思消息
 * （Reflexion 机制），失败记录随注入重置；反思/续写消息只存在于本次调用的
 * 内存消息流中，不落库、不跨 Run 生效。
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
  let continuationTurns = 0

  while (true) {
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

    const disposition = requireModelTurnDisposition(
      turn.finishReason,
      turn.toolCalls,
    )

    if (disposition.kind === 'final') {
      messages.push({
        role: 'assistant',
        content: turn.content,
        toolCalls: [],
      })
      return { status: 'completed', turns, finalTurn: turn, messages }
    }

    if (disposition.kind === 'truncated') {
      if (continuationTurns >= DEFAULT_MAX_CONTINUATION_TURNS) {
        return {
          status: 'stopped',
          turns,
          reason: 'output_truncated',
          messages,
        }
      }
      continuationTurns += 1
      // 截断片段作为已完成模型轮保留在消息流中，追加续写控制帧后继续。
      messages.push({
        role: 'assistant',
        content: turn.content,
        toolCalls: [],
      })
      messages.push(buildContinuationMessage())
      continue
    }

    if (disposition.kind === 'blocked') {
      return {
        status: 'stopped',
        turns,
        reason: 'content_filtered',
        messages,
      }
    }

    // disposition.kind === 'tools'
    messages.push({
      role: 'assistant',
      content: turn.content,
      toolCalls: turn.toolCalls,
    })

    // 批量执行：Runtime 注入的副作用调度器负责并行/串行批次与顺序回填，
    // 结果数组与 toolCalls 一一对应，保证 role=tool 消息与 tool_calls 稳定配对。
    const results = await options.executeToolBatch(
      turn.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
      signal,
    )
    for (let i = 0; i < turn.toolCalls.length; i += 1) {
      const call = turn.toolCalls[i]
      const result = results[i]
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

    if (turns >= maxTurns) {
      return { status: 'stopped', turns, reason: 'max_turns', messages }
    }
  }
}
