import type { ContextFrame } from '../frames.js'
import { estimateFrameTokens } from './estimate.js'
import { shrinkLargestFrameContent } from './shrink.js'
import { continuationFrames } from './continuation.js'

/**
 * 把"稳定旧 Frame"折叠为一条摘要消息（Frame 边界切割，不拆工具轮）。
 * 返回投影后的消息序列：system + 摘要 + 保留的最近 Frame。
 */
export async function compactFrames(options: {
  frames: ContextFrame[]
  budgetTokens: number
  /** 始终原样保留的最近 Frame 数（工具轮整体计一）。 */
  keepRecentFrames: number
  summarize(stableFrames: ContextFrame[]): Promise<string>
}): Promise<{
  frames: ContextFrame[]
  compacted: boolean
  summary: string | null
}> {
  const { frames, budgetTokens, keepRecentFrames } = options
  if (estimateFrameTokens(frames) <= budgetTokens) {
    return { frames, compacted: false, summary: null }
  }
  const head = frames[0]?.kind === 'system' ? 1 : 0
  const system = head === 1 ? frames[0] : null
  const body = frames.slice(head)
  const keep = Math.min(keepRecentFrames, body.length)
  const stable = body.slice(0, body.length - keep)
  const recent = body.slice(body.length - keep)
  if (stable.length === 0) {
    return { frames, compacted: false, summary: null }
  }
  const summary = await options.summarize(stable)
  const summaryFrame: ContextFrame = {
    kind: 'user',
    content: `[历史摘要]\n${summary}`,
  }
  const compacted = [...(system ? [system] : []), summaryFrame, ...recent]
  return { frames: compacted, compacted: true, summary }
}

/**
 * 轮内 Frame 兜底裁剪：按 Frame 从最旧开始折叠（工具轮整体折叠为说明文本），
 * 全部折叠完仍超预算则截断到最近窗口。不产生悬空 tool result。
 */
export function boundFramesForModel(
  frames: ContextFrame[],
  budgetTokens: number,
  keepRecentFrames = 8,
): ContextFrame[] {
  let current = [...frames]
  if (estimateFrameTokens(current) <= budgetTokens) return current
  let folded = foldOldestToolRoundFrame(current, keepRecentFrames)
  while (folded !== null) {
    current = folded
    if (estimateFrameTokens(current) <= budgetTokens) return current
    folded = foldOldestToolRoundFrame(current, keepRecentFrames)
  }
  // 截断兜底：保留 system + 最近 Frame 窗口。
  const head = current[0]?.kind === 'system' ? 1 : 0
  const system = head === 1 ? current[0] : null
  const body = current.slice(head)
  const keep = Math.min(keepRecentFrames, body.length)
  const continuation = continuationFrames(current)
  const recent = body.slice(body.length - keep)
  const taskFrames = current.filter(
    (frame) =>
      frame.kind === 'runtime_control' && frame.control === 'task_context',
  )
  const latestUser = [...current]
    .reverse()
    .find((frame) => frame.kind === 'user')
  const bounded: ContextFrame[] = [
    ...(system ? [system] : []),
    { kind: 'user', content: '[更早的历史已因上下文超长被截断]' },
    ...(continuation.task && !recent.includes(continuation.task)
      ? [continuation.task]
      : []),
    ...(continuation.tail && !recent.includes(continuation.tail)
      ? [continuation.tail]
      : []),
    ...taskFrames.filter((frame) => !recent.includes(frame)),
    ...(latestUser &&
    !recent.includes(latestUser) &&
    latestUser !== continuation.task
      ? [latestUser]
      : []),
    ...recent,
  ]
  const protectedIndices = new Set(
    bounded.flatMap((frame, index) =>
      frame === continuation.task ||
      frame === continuation.control ||
      frame === latestUser ||
      taskFrames.includes(frame)
        ? [index]
        : [],
    ),
  )
  const tailIndex = continuation.tail ? bounded.indexOf(continuation.tail) : -1
  // 窗口内单 Frame 仍超预算（如粘贴巨文）：收缩最大非 system Frame。
  let shrinkPasses = 0
  while (estimateFrameTokens(bounded) > budgetTokens && shrinkPasses < 48) {
    shrinkPasses += 1
    if (!shrinkLargestFrameContent(bounded, protectedIndices, tailIndex)) break
  }
  return bounded
}

/** 折叠最老的工具轮 Frame 为说明性 assistant 文本；无可折叠返回 null。 */
function foldOldestToolRoundFrame(
  frames: ContextFrame[],
  keepRecentFrames: number,
): ContextFrame[] | null {
  const head = frames[0]?.kind === 'system' ? 1 : 0
  const protectedStart = Math.max(head, frames.length - keepRecentFrames)
  for (let i = head; i < protectedStart; i += 1) {
    const frame = frames[i]
    if (frame.kind !== 'tool_round') continue
    const prefix =
      frame.assistant.content === '' ? '' : `${frame.assistant.content}\n`
    const folded: ContextFrame = {
      kind: 'assistant_text',
      content: `${prefix}[此前的 ${frame.assistant.toolCalls.length} 个工具调用及其结果已因上下文过长省略]`,
    }
    const kept = [...frames]
    kept.splice(i, 1, folded)
    return kept
  }
  return null
}
