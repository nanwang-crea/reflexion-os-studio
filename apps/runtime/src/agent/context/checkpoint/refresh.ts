import type { ContextCheckpointSummary } from '@reflexion-os-studio/contracts'
import type { ContextFrame } from '@reflexion-os-studio/agent-core'
import type { Store } from '../../../store/index.js'
import type { ProviderRuntimeConfig } from '../budget.js'
import {
  ensureCheckpoint,
  summarizeCheckpointFrames,
} from '../context-checkpoint.js'
import type { CheckpointFailure } from '../context-checkpoint.js'

export interface CheckpointRefreshInput {
  store: Store
  sessionId: string
  provider: ProviderRuntimeConfig
  signal: AbortSignal
  stableFrames: ContextFrame[]
  stableIds: (string | null)[]
  throughMessageId: string | null
  /** 有效 checkpoint 的既有摘要：作为增量基座（stableFrames 只含水位后新帧）。 */
  previousSummaryOverride?: ContextCheckpointSummary | null
  validateSource: () => boolean
  onStage?: (stage: 'start' | 'done') => void
}

/**
 * 后台 checkpoint 刷新：只写派生缓存，从不参与本轮首字关键路径。
 * 失败保留旧 checkpoint（调用方照常走确定性裁剪），并向 stderr 输出
 * 稳定阶段/分类码/结果，避免再出现“反复摘要却始终不落库且无日志”。
 */
export function refreshCheckpoint(input: CheckpointRefreshInput): void {
  if (input.stableFrames.length === 0 || input.throughMessageId === null) return
  const { sessionId } = input
  input.onStage?.('start')
  const startedAt = Date.now()
  void ensureCheckpoint({
    store: input.store,
    sessionId,
    provider: input.provider,
    summarize: (summaryInput) =>
      summarizeCheckpointFrames(input.provider, {
        ...summaryInput,
        diagnostics: { store: input.store, sessionId },
      }),
    stableFrames: input.stableFrames,
    stableIds: input.stableIds,
    throughMessageId: input.throughMessageId,
    signal: input.signal,
    ...(input.previousSummaryOverride !== undefined
      ? { previousSummaryOverride: input.previousSummaryOverride }
      : {}),
    // 只记录稳定失败阶段/分类码，不携带摘要正文或 Provider 细节。
    onFailure: (failure: CheckpointFailure) => {
      process.stderr.write(
        `[metrics] checkpointRefreshFailed:true sessionId:${sessionId.slice(0, 8)} stage:${failure.stage} reason:${failure.reason}\n`,
      )
    },
    validateSource: input.validateSource,
  })
    .then((outcome) => {
      input.onStage?.('done')
      const state = outcome.hit
        ? 'hit'
        : outcome.failed
          ? outcome.skipped
            ? 'skipped'
            : 'failed'
          : 'summarized'
      process.stderr.write(
        `[metrics] checkpointRefresh:${state} sessionId:${sessionId.slice(0, 8)} sourceHash:${outcome.sourceHash.slice(0, 8)} elapsedMs:${Date.now() - startedAt}${
          outcome.failure !== null ? ` reason:${outcome.failure.reason}` : ''
        }\n`,
      )
    })
    .catch((error) => {
      input.onStage?.('done')
      if (!(error instanceof Error && error.name === 'AbortError')) {
        process.stderr.write(
          `[runtime] background checkpoint refresh failed: ${String(error)}\n`,
        )
      }
    })
}
