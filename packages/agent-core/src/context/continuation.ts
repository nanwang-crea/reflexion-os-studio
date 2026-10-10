import type { ContextFrame } from '../frames.js'

/** 只依据 Runtime 内部标记识别续写，不将用户正文前缀当成控制指令。 */
export function continuationFrames(frames: ContextFrame[]): {
  task: ContextFrame | undefined
  tail: ContextFrame | undefined
  control: ContextFrame | undefined
} {
  const control = frames.at(-1)
  if (control?.kind !== 'runtime_control' || control.control !== 'continuation')
    return { task: undefined, tail: undefined, control: undefined }
  let task: ContextFrame | undefined
  let tail: ContextFrame | undefined
  for (let i = frames.length - 2; i >= 0; i -= 1) {
    const frame = frames[i]
    if (tail === undefined && frame.kind === 'assistant_text') tail = frame
    if (frame.kind === 'user') {
      task = frame
      break
    }
  }
  return { task, tail, control }
}
