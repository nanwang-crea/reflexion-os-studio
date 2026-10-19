import {
  estimateTokens,
  type ContextFrame,
} from '@reflexion-os-studio/agent-core'

/** Text-only summary projection; no clipping, native signatures or image bytes. */
function* transcriptParts(frames: ContextFrame[]): Generator<string> {
  for (const frame of frames) {
    if (frame.kind === 'system') continue
    if (frame.kind === 'tool_round') {
      yield JSON.stringify({
        role: 'assistant',
        content: frame.assistant.content,
        toolCalls: frame.assistant.toolCalls.map(
          ({ id, name, arguments: args }) => ({ id, name, arguments: args }),
        ),
      }) + '\n'
      for (const result of frame.results)
        yield JSON.stringify({
          role: 'tool',
          toolCallId: result.toolCallId,
          isError: result.isError,
          content: result.content,
          images: result.images?.map(({ assetId, mimeType }) => ({
            assetId,
            mimeType,
          })),
        }) + '\n'
      continue
    }
    yield JSON.stringify({
      role: frame.kind === 'assistant_text' ? 'assistant' : 'user',
      content: frame.content,
      ...(frame.kind === 'user' && frame.images?.length
        ? {
            images: frame.images.map(({ assetId, mimeType }) => ({
              assetId,
              mimeType,
            })),
          }
        : {}),
    }) + '\n'
  }
}

export function transcriptOf(frames: ContextFrame[]): string {
  return [...transcriptParts(frames)].join('')
}

/** Re-evaluate space after each summary; every source character is consumed once. */
export function* transcriptChunks(
  frames: ContextFrame[],
  budget: () => number,
): Generator<string> {
  let buffer = ''
  for (const part of transcriptParts(frames)) {
    let offset = 0
    while (offset < part.length) {
      const available = budget() - estimateTokens(buffer)
      const length = prefixLength(part, offset, available)
      if (length === 0) {
        if (!buffer) throw new Error('checkpoint summary: no input space')
        yield buffer
        buffer = ''
        continue
      }
      buffer += part.slice(offset, offset + length)
      offset += length
    }
  }
  if (buffer) yield buffer
}

function prefixLength(text: string, offset: number, tokens: number): number {
  if (tokens < 1) return 0
  let low = 0
  let high = Math.min(text.length - offset, tokens * 4)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(offset, offset + middle)) <= tokens)
      low = middle
    else high = middle - 1
  }
  // Never split a UTF-16 surrogate pair across summary requests.
  const last = text.charCodeAt(offset + low - 1)
  if (last >= 0xd800 && last <= 0xdbff) low -= 1
  return low
}
