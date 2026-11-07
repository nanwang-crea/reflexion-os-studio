import {
  estimateTokens,
  type ContextFrame,
} from '@reflexion-os-studio/agent-core'
import type { ContextCheckpointSummary } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { emptySummary } from '../../store/agents/contextCheckpoints.js'
import type { ProviderRuntimeConfig } from './budget.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  computeSourceHash,
} from './checkpoint/source.js'
import { sanitizeSummary } from './checkpoint/summary.js'
import {
  classifyCheckpointError,
  clearAllSessionFailures,
  clearSessionFailure,
  recordSessionFailure,
  sessionBackoffActive,
} from './checkpoint/failure.js'

export {
  CHECKPOINT_SCHEMA_VERSION,
  computeSourceHash,
} from './checkpoint/source.js'
export { sanitizeSummary, filterSecretLine } from './checkpoint/summary.js'
export { transcriptOf } from './checkpoint/transcript.js'
export {
  summarizeCheckpointFrames,
  SUMMARY_MAX_OUTPUT_TOKENS,
} from './checkpoint/request.js'
export type { ContextCheckpointSummary } from '@reflexion-os-studio/contracts'

/** Single-flight success cache; failed refreshes never replace an earlier checkpoint. */
export interface CheckpointOptions {
  store: Store
  sessionId: string
  provider: ProviderRuntimeConfig
  /** 结构化摘要模型调用（注入以便 mock 测试）。 */
  summarize(input: {
    previousSummary: ContextCheckpointSummary | null
    newFrames: ContextFrame[]
    signal: AbortSignal
  }): Promise<unknown>
  /** Checkpoint 覆盖的稳定 Frame（不含最近窗口；含头 system 时忽略）。 */
  stableFrames: ContextFrame[]
  /** 稳定窗口内各 Frame 的来源消息 id（watermark 定位增量起点）。 */
  stableIds?: (string | null)[]
  /** 稳定窗口最后一个来源消息 id（watermark 落库值）。 */
  throughMessageId: string | null
  signal: AbortSignal
  validateSource?: () => boolean
  /**
   * 调用方已确认既有摘要仍覆盖前缀（有效 checkpoint + 触发器保证），
   * 直接把它作为增量基座；此时 stableFrames 只包含水位之后的新帧。
   */
  previousSummaryOverride?: ContextCheckpointSummary | null
  /** 刷新失败的可观测回调；reason 只含稳定分类码，不含正文或凭据。 */
  onFailure?: (failure: CheckpointFailure) => void
}

/** 刷新失败阶段 + 稳定分类码（供日志/指标，绝不携带摘要正文）。 */
export interface CheckpointFailure {
  stage: 'summarize' | 'validate' | 'schema' | 'store'
  reason: string
}

export interface CheckpointOutcome {
  summary: ContextCheckpointSummary
  sourceHash: string
  /** 相同 hash 命中既有 Checkpoint（未调用模型）。 */
  hit: boolean
  /** 摘要失败（走失败缓存）；调用方应退化为确定性裁剪。 */
  failed: boolean
  /** 本次是否真正调用了摘要模型。 */
  summarized: boolean
  /** 会话级退避中主动跳过（未调用模型）。 */
  skipped: boolean
  failure: CheckpointFailure | null
}

/** Runtime 内 single-flight：相同 sessionId+hash 的并发摘要只发一次。 */
const inflight = new Map<string, Promise<CheckpointOutcome>>()
/** 同 hash 短时冷却，既限制重试风暴，也允许暂时故障恢复。 */
const failedHashes = new Map<string, number>()
export const CHECKPOINT_FAILURE_COOLDOWN_MS = 30_000
export {
  CHECKPOINT_SESSION_BACKOFF_BASE_MS,
  CHECKPOINT_SESSION_BACKOFF_MAX_MS,
  classifyCheckpointError,
} from './checkpoint/failure.js'
const MAX_FAILED_HASHES = 256

/** 测试辅助：清空模块级 single-flight/冷却/退避状态。 */
export function resetCheckpointState(): void {
  inflight.clear()
  failedHashes.clear()
  clearAllSessionFailures()
}

export async function ensureCheckpoint(
  options: CheckpointOptions,
): Promise<CheckpointOutcome> {
  const { sessionId, stableFrames } = options
  const sourceHash = computeSourceHash(stableFrames)
  if (stableFrames.length === 0) {
    return {
      summary: emptySummary(),
      sourceHash,
      hit: false,
      failed: false,
      summarized: false,
      skipped: false,
      failure: null,
    }
  }
  const flightKey = `${sessionId}:${sourceHash}`
  const inFlight = inflight.get(flightKey)
  if (inFlight) return inFlight
  const task = runEnsure(options, sourceHash, flightKey)
  inflight.set(flightKey, task)
  try {
    return await task
  } finally {
    inflight.delete(flightKey)
  }
}

async function runEnsure(
  options: CheckpointOptions,
  sourceHash: string,
  flightKey: string,
): Promise<CheckpointOutcome> {
  const { store, sessionId, stableFrames, throughMessageId, provider } = options
  // source hash 变化（retry/supersede/删除/重放差异）→ 旧 Checkpoint 失效。
  const existingRow = store.contextCheckpoints.get(sessionId)
  if (
    existingRow !== null &&
    existingRow.sourceHash === sourceHash &&
    existingRow.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
    usableSummary(existingRow.summary)
  ) {
    clearSessionFailure(sessionId)
    return {
      summary: existingRow.summary,
      sourceHash,
      hit: true,
      failed: false,
      summarized: false,
      skipped: false,
      failure: null,
    }
  }
  // 会话级连续失败退避：来源 hash 随历史增长而变化，只按 hash 冷却无法挡住
  // 每次 Run 都重新摘要。退避期间直接跳过，避免重复消耗 32K 输入。
  if (sessionBackoffActive(sessionId)) {
    return {
      summary: emptySummary(),
      sourceHash,
      hit: false,
      failed: true,
      summarized: false,
      skipped: true,
      failure: { stage: 'summarize', reason: 'backoff' },
    }
  }
  if ((failedHashes.get(flightKey) ?? 0) > Date.now()) {
    return {
      summary: emptySummary(),
      sourceHash,
      hit: false,
      failed: true,
      summarized: false,
      skipped: true,
      failure: { stage: 'summarize', reason: 'cooldown' },
    }
  }
  let stage: CheckpointFailure['stage'] = 'summarize'
  try {
    // 增量起点：有显式基座（水位后缀刷新）时直接用；否则在稳定窗口内
    // 定位旧 watermark（历史被清理/supersede 则全量重摘要）。
    const forcedPrevious = options.previousSummaryOverride
    const watermarkIndex =
      forcedPrevious !== undefined ||
      existingRow === null ||
      options.stableIds === undefined
        ? -1
        : options.stableIds.lastIndexOf(existingRow.throughMessageId)
    const canExtendExisting =
      forcedPrevious !== undefined
        ? forcedPrevious !== null
        : existingRow !== null &&
          existingRow.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
          usableSummary(existingRow.summary) &&
          watermarkIndex >= 0 &&
          computeSourceHash(stableFrames.slice(0, watermarkIndex + 1)) ===
            existingRow.sourceHash
    const previousSummary =
      forcedPrevious !== undefined
        ? forcedPrevious
        : canExtendExisting
          ? existingRow!.summary
          : null
    const newFrames =
      forcedPrevious !== undefined
        ? stableFrames
        : canExtendExisting
          ? stableFrames.slice(watermarkIndex + 1)
          : stableFrames
    const raw = await options.summarize({
      previousSummary,
      newFrames,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    stage = 'validate'
    if (options.validateSource && !options.validateSource())
      throw new Error('checkpoint source changed during summarization')
    stage = 'schema'
    const summary = sanitizeSummary(raw)
    stage = 'store'
    store.contextCheckpoints.upsert({
      sessionId,
      throughMessageId,
      sourceHash,
      summary,
      tokenEstimate: estimateSummaryTokens(summary),
      model: provider.model,
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    })
    clearSessionFailure(sessionId)
    failedHashes.delete(flightKey)
    return {
      summary,
      sourceHash,
      hit: false,
      failed: false,
      summarized: true,
      skipped: false,
      failure: null,
    }
  } catch (error) {
    if (options.signal.aborted) throw error
    const failure: CheckpointFailure = {
      stage,
      reason: classifyCheckpointError(error),
    }
    recordSessionFailure(sessionId)
    failedHashes.delete(flightKey)
    failedHashes.set(flightKey, Date.now() + CHECKPOINT_FAILURE_COOLDOWN_MS)
    if (failedHashes.size > MAX_FAILED_HASHES)
      failedHashes.delete(failedHashes.keys().next().value!)
    try {
      options.onFailure?.(failure)
    } catch {
      // 诊断回调不得掩盖原始失败。
    }
    return {
      summary: emptySummary(),
      sourceHash,
      hit: false,
      failed: true,
      summarized: false,
      skipped: false,
      failure,
    }
  }
}

function estimateSummaryTokens(summary: ContextCheckpointSummary): number {
  return estimateTokens(JSON.stringify(summary))
}

function usableSummary(raw: unknown): boolean {
  try {
    sanitizeSummary(raw)
    return true
  } catch {
    return false
  }
}
