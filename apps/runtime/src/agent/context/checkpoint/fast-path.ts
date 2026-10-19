import {
  boundFramesForModel,
  type ModelMessage,
} from '@reflexion-os-studio/agent-core'
import type { Store } from '../../../store/index.js'
import {
  framesToValidatedMessages,
  reconstructSessionFramesWithIds,
} from '../context-frames.js'
import { CHECKPOINT_SCHEMA_VERSION } from './source.js'
import { sanitizeSummary } from './summary.js'
import { formatCheckpointBlock } from './format.js'

/** Prefix edits invalidate this row in SQLite, so a cache hit never scans the prefix. */
export function readCheckpointTail(
  store: Store,
  sessionId: string,
  systemPrompt: string,
  budget: number,
  keep: number,
): ModelMessage[] | null {
  const checkpoint = store.contextCheckpoints.get(sessionId)
  if (
    !checkpoint?.throughMessageId ||
    checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION
  )
    return null
  const watermark = store.messages.get(checkpoint.throughMessageId)
  if (
    !watermark ||
    watermark.sessionId !== sessionId ||
    watermark.status === 'superseded'
  )
    return null
  let summary
  try {
    summary = sanitizeSummary(checkpoint.summary)
  } catch {
    return null
  }
  const tail = reconstructSessionFramesWithIds(store, sessionId, systemPrompt, {
    after: checkpoint.throughMessageId,
  })
  // Refresh every eight new stable frames, preserving the existing cadence.
  if (tail.frames.length - 1 >= keep * 2) return null
  return framesToValidatedMessages(
    boundFramesForModel(
      [
        {
          kind: 'system',
          content: `${systemPrompt}\n\n${formatCheckpointBlock(summary)}`,
        },
        ...tail.frames.slice(1),
      ],
      budget,
      keep,
    ),
  )
}
