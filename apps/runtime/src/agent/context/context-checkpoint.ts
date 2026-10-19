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
export {
  CHECKPOINT_SCHEMA_VERSION,
  computeSourceHash,
} from './checkpoint/source.js'
export { sanitizeSummary, filterSecretLine } from './checkpoint/summary.js'
export { transcriptOf } from './checkpoint/transcript.js'
export { summarizeCheckpointFrames } from './checkpoint/request.js'
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
}

/** Runtime 内 single-flight：相同 sessionId+hash 的并发摘要只发一次。 */
const inflight = new Map<string, Promise<CheckpointOutcome>>()
/** 同 hash 短时冷却，既限制重试风暴，也允许暂时故障恢复。 */
const failedHashes = new Map<string, number>()
export const CHECKPOINT_FAILURE_COOLDOWN_MS = 30_000
const MAX_FAILED_HASHES = 256

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
    return {
      summary: existingRow.summary,
      sourceHash,
      hit: true,
      failed: false,
      summarized: false,
    }
  }
  if ((failedHashes.get(flightKey) ?? 0) > Date.now()) {
    return {
      summary: emptySummary(),
      sourceHash,
      hit: false,
      failed: true,
      summarized: false,
    }
  }
  try {
    // 增量起点：旧 Checkpoint 的 watermark 在本次稳定窗口内的位置；
    // 找不到（历史被清理/supersede）则全量重摘要。
    const watermarkIndex =
      existingRow === null || options.stableIds === undefined
        ? -1
        : options.stableIds.lastIndexOf(existingRow.throughMessageId)
    const canExtendExisting =
      existingRow !== null &&
      existingRow.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
      usableSummary(existingRow.summary) &&
      watermarkIndex >= 0 &&
      computeSourceHash(stableFrames.slice(0, watermarkIndex + 1)) ===
        existingRow.sourceHash
    const previousSummary = canExtendExisting ? existingRow.summary : null
    const newFrames = canExtendExisting
      ? stableFrames.slice(watermarkIndex + 1)
      : stableFrames
    const raw = await options.summarize({
      previousSummary,
      newFrames,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const summary = sanitizeSummary(raw)
    failedHashes.delete(flightKey)
    store.contextCheckpoints.upsert({
      sessionId,
      throughMessageId,
      sourceHash,
      summary,
      tokenEstimate: estimateSummaryTokens(summary),
      model: provider.model,
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    })
    return {
      summary,
      sourceHash,
      hit: false,
      failed: false,
      summarized: true,
    }
  } catch (error) {
    if (options.signal.aborted) throw error
    failedHashes.delete(flightKey)
    failedHashes.set(flightKey, Date.now() + CHECKPOINT_FAILURE_COOLDOWN_MS)
    if (failedHashes.size > MAX_FAILED_HASHES)
      failedHashes.delete(failedHashes.keys().next().value!)
    return {
      summary: emptySummary(),
      sourceHash,
      hit: false,
      failed: true,
      summarized: false,
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
