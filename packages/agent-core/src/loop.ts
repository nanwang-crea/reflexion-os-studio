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
  return `[反思] 最近的 ${failedTools.length} 次工具调用失败（${names}）。依据工具返回的错误证据选择恢复动作，并继续执行已授权的原任务。原因不明时先验证，不要猜测原因或原样重试；需要说明时只简短说明下一步，不要把反思或修正策略当作最终答复。`
}

/** length 续写控制帧：仅存在于当前 Run 的内存消息流，不落库。 */
function buildContinuationMessage(hasContent: boolean): ModelMessage {
  return {
    role: 'user',
    control: 'continuation',
    content: hasContent
      ? '[续写] 上一条回复因长度限制被截断。请从截断点继续输出，不要重复已有内容，也不要重新开始；完成后正常结束。'
      : '[恢复] 上一轮因输出上限停止，仅返回思考，尚未生成正文或工具调用。请继续处理原任务，分步输出答案或完整工具调用；不要重复此前已成功执行的操作。',
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
  const maxContinuationTurns =
    options.maxContinuationTurns ?? DEFAULT_MAX_CONTINUATION_TURNS
  const reflectionThreshold =
    options.reflectionThreshold ?? DEFAULT_REFLECTION_THRESHOLD
  const messages: ModelMessage[] = [...history]
  const taskMessage = [...history]
    .reverse()
    .find((message) => message.role === 'user' && message.control === undefined)
  let turns = 0
  let failuresSinceReflection = 0
  let failedToolNames: string[] = []
  let continuationTurns = 0
  let toolRecoveryAttempts = 0

  while (true) {
    if (signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    if (turns >= maxTurns) {
      return { status: 'stopped', turns, reason: 'max_turns', messages }
    }
    if (
      reflectionThreshold > 0 &&
      failuresSinceReflection >= reflectionThreshold
    ) {
      messages.push({
        role: 'user',
        control: 'reflection',
        content: buildReflectionMessage(failedToolNames),
      })
      failuresSinceReflection = 0
      failedToolNames = []
    }
    // 旧工具轮可能已裁掉任务消息；续写前重新带入同一 Run 的原任务。
    const lastMessage = messages.at(-1)
    if (
      lastMessage?.role === 'user' &&
      lastMessage.control === 'continuation' &&
      taskMessage &&
      !messages.some(
        (message) =>
          message.role === 'user' &&
          message.control === undefined &&
          message.content === taskMessage.content,
      )
    ) {
      messages.splice(Math.max(0, messages.length - 2), 0, taskMessage)
    }
    if (options.prepareMessages !== undefined) {
      const prepared = options.prepareMessages(messages)
      if (prepared !== messages) {
        messages.splice(0, messages.length, ...prepared)
      }
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

    if (disposition.kind === 'context_limit') {
      return { status: 'stopped', turns, reason: 'context_limit', messages }
    }

    if (disposition.kind === 'tool_truncated') {
      // 本轮没有执行工具；拒绝把不完整调用加入合法历史，重试不重放旧工具。
      if (toolRecoveryAttempts >= 1) {
        return {
          status: 'stopped',
          turns,
          reason: 'tool_output_truncated',
          messages,
        }
      }
      toolRecoveryAttempts += 1
      options.onRecovery?.({ kind: 'tools', attempt: toolRecoveryAttempts })
      messages.push({
        role: 'user',
        control: 'tool_recovery',
        content:
          '[续写] 上一轮工具参数因输出上限被截断，整批工具均未执行。请重新生成完整工具调用，缩小单次参数和操作批次，必要时分步执行。不要重做此前已成功的操作。',
      })
      continue
    }

    if (disposition.kind === 'truncated') {
      const hasContent = turn.content.trim() !== ''
      const hasReasoning = (turn.reasoning ?? '').trim() !== ''
      // 即使额度耗尽，最后一个片段也必须保留。
      // 空正文不回填 assistant，避免供应商拒绝空消息；思考由 Runtime 保存。
      if (hasContent) {
        messages.push({
          role: 'assistant',
          content: turn.content,
          toolCalls: [],
        })
      }
      if (!hasContent && !hasReasoning) {
        return { status: 'stopped', turns, reason: 'output_empty', messages }
      }
      if (continuationTurns >= maxContinuationTurns) {
        return {
          status: 'stopped',
          turns,
          reason: 'output_truncated',
          messages,
        }
      }
      continuationTurns += 1
      options.onRecovery?.({
        kind: hasContent ? 'text' : 'reasoning',
        attempt: continuationTurns,
      })
      messages.push(buildContinuationMessage(hasContent))
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

    // 完整工具轮打断连续截断；工具执行错误不改变模型轮的完整性。
    continuationTurns = 0
    toolRecoveryAttempts = 0
    // disposition.kind === 'tools'
    messages.push({
      role: 'assistant',
      content: turn.content,
      toolCalls: turn.toolCalls,
    })

    // 批量执行：Runtime 注入的副作用调度器负责并行/串行批次、顺序回填与
    // Loop Guard 拦截；结果数组与 toolCalls 一一对应。
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
