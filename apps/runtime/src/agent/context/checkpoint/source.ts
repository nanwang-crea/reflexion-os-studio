import { createHash } from 'node:crypto'
import type { ContextFrame } from '@reflexion-os-studio/agent-core'

/** v2 invalidates summaries produced from silently clipped transcripts. */
export const CHECKPOINT_SCHEMA_VERSION = 2

/** source hash：稳定 Frame 内容的确定性摘要（存哈希不存原文）。 */
export function computeSourceHash(
  frames: ContextFrame[],
  schemaVersion = CHECKPOINT_SCHEMA_VERSION,
): string {
  const hash = createHash('sha256')
  hash.update(`v${schemaVersion}|frames=${frames.length}|`)
  for (const frame of frames) {
    switch (frame.kind) {
      case 'system':
        hash.update(`system|${frame.content.length}|`)
        break
      case 'user':
      case 'assistant_text':
      case 'runtime_control':
        hash.update(`${frame.kind}|${frame.content}|`)
        if (frame.kind === 'user' && frame.images?.length)
          hash.update(
            JSON.stringify(
              frame.images.map(({ assetId, mimeType }) => ({
                assetId,
                mimeType,
              })),
            ),
          )
        break
      case 'tool_round': {
        hash.update(`tool_round|${frame.assistant.content}|`)
        for (const call of frame.assistant.toolCalls) {
          hash.update(
            `${call.id}|${call.name}|${createHash('sha256').update(call.arguments).digest('hex')}|`,
          )
        }
        for (const result of frame.results) {
          hash.update(
            `${result.toolCallId}|${result.isError ? 'err' : 'ok'}|${createHash('sha256').update(result.content).digest('hex')}|`,
          )
        }
        break
      }
    }
  }
  return hash.digest('hex')
}
