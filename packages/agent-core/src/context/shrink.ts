import type { ContextFrame } from '../frames.js'

interface ShrinkTarget {
  frameIndex: number
  resultIndex: number | null
  text: string
}

/** 收缩最大正文；工具结果只改 content，保持 call/result 配对与错误状态。 */
export function shrinkLargestFrameContent(
  frames: ContextFrame[],
  protectedIndices: Set<number>,
  tailIndex: number,
): boolean {
  let target: ShrinkTarget | null = null
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]
    if (frame.kind === 'system' || protectedIndices.has(i)) continue
    if (frame.kind !== 'tool_round') {
      if (target === null || frame.content.length > target.text.length) {
        target = { frameIndex: i, resultIndex: null, text: frame.content }
      }
      continue
    }
    if (
      target === null ||
      frame.assistant.content.length > target.text.length
    ) {
      target = {
        frameIndex: i,
        resultIndex: null,
        text: frame.assistant.content,
      }
    }
    for (let j = 0; j < frame.results.length; j += 1) {
      const text = frame.results[j].content
      if (target === null || text.length > target.text.length) {
        target = { frameIndex: i, resultIndex: j, text }
      }
    }
  }
  if (target === null || target.text.length < 32) return false
  const keepTail = target.frameIndex === tailIndex
  const half = keepTail
    ? target.text.slice(-Math.floor(target.text.length / 2))
    : target.text.slice(0, Math.floor(target.text.length / 2))
  const truncated = keepTail
    ? `（此前正文因上下文超长省略）…${half}`
    : `${half}…（因上下文超长被截断）`
  const frame = frames[target.frameIndex]
  if (frame.kind !== 'tool_round') {
    frames[target.frameIndex] = { ...frame, content: truncated }
    return true
  }
  if (target.resultIndex === null) {
    frames[target.frameIndex] = {
      ...frame,
      assistant: { ...frame.assistant, content: truncated },
    }
    return true
  }
  frames[target.frameIndex] = {
    ...frame,
    results: frame.results.map((result, index) =>
      index === target.resultIndex ? { ...result, content: truncated } : result,
    ),
  }
  return true
}
