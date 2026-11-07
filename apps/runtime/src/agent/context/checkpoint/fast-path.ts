import {
  boundFramesForModel,
  type ContextFrame,
  type ModelMessage,
} from '@reflexion-os-studio/agent-core'
import type { ContextCheckpointSummary } from '@reflexion-os-studio/contracts'
import type { Store } from '../../../store/index.js'
import {
  framesToValidatedMessages,
  reconstructSessionFramesWithIds,
} from '../context-frames.js'
import { CHECKPOINT_SCHEMA_VERSION } from './source.js'
import { sanitizeSummary } from './summary.js'
import { formatCheckpointBlock } from './format.js'

/** 有效 checkpoint 的水位后缀 + 后台增量刷新所需元数据。 */
export interface CheckpointTail {
  messages: ModelMessage[]
  /** 水位之后、最近窗口之前的稳定帧（可安全追加进摘要）。 */
  stableFrames: ContextFrame[]
  stableIds: (string | null)[]
  /** 新 checkpoint 的水位（稳定帧最后一条来源消息）。 */
  throughMessageId: string | null
  /** 旧 checkpoint 的水位（校验增量来源未变）。 */
  baseThroughMessageId: string
  previousSummary: ContextCheckpointSummary
  /** 是否达到“再累积一个最近窗口”的刷新节奏。 */
  refreshDue: boolean
}

/**
 * 有效 checkpoint 直接读取水位后的后缀，不再全量重建历史。
 * 前缀正确性由 messages/tool_calls 上的 SQLite 触发器保证：任何水位之前
 * 的增删改都会删除该 checkpoint；这里只校验 schema、水位存在性与摘要结构。
 * `stableFrames` 供后台把水位继续前移；`refreshDue` 复用“新增一个最近窗口
 * 的稳定帧”这一既有刷新节奏。
 */
export function readCheckpointTail(
  store: Store,
  sessionId: string,
  systemPrompt: string,
  budget: number,
  keep: number,
): CheckpointTail | null {
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
  let summary: ContextCheckpointSummary
  try {
    summary = sanitizeSummary(checkpoint.summary)
  } catch {
    return null
  }
  const tail = reconstructSessionFramesWithIds(store, sessionId, systemPrompt, {
    after: checkpoint.throughMessageId,
  })
  const body = tail.frames.slice(1)
  const bodyIds = tail.messageIds.slice(1)
  const keepCount = Math.min(keep, body.length)
  const stableFrames = body.slice(0, body.length - keepCount)
  const stableIds = bodyIds.slice(0, stableFrames.length)
  const throughMessageId =
    [...stableIds].reverse().find((id) => id !== null) ?? null
  return {
    messages: framesToValidatedMessages(
      boundFramesForModel(
        [
          {
            kind: 'system',
            content: `${systemPrompt}\n\n${formatCheckpointBlock(summary)}`,
          },
          ...body,
        ],
        budget,
        keep,
      ),
    ),
    stableFrames,
    stableIds,
    throughMessageId,
    baseThroughMessageId: checkpoint.throughMessageId,
    previousSummary: summary,
    refreshDue: stableFrames.length >= keep,
  }
}
