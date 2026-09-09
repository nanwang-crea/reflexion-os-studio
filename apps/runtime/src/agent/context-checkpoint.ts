import { createHash } from 'node:crypto'
import {
  ContextCheckpointSummarySchema,
  type ContextCheckpointSummary,
} from '@reflexion-os-studio/contracts'
export type { ContextCheckpointSummary } from '@reflexion-os-studio/contracts'
import type { ContextFrame } from '@reflexion-os-studio/agent-core'
import type { Store } from '../store/index.js'
import { emptySummary } from '../store/contextCheckpoints.js'
import type { ProviderRuntimeConfig } from './context.js'
import { CHECKPOINT_SUMMARY_SYSTEM_PROMPT } from './prompts/index.js'

/**
 * 增量 Context Checkpoint 服务（W5）：
 * - source hash 覆盖稳定 Frame 内容（message id/role/content、ToolCall 参数/
 *   结果哈希）+ summary schema version；来源变化即失效，不依赖手工清缓存；
 * - 命中相同 hash 直接复用；watermark 后新增稳定 Frame 只做一次增量摘要
 *   （输入 = 旧摘要 + 新增 Frame）；
 * - 相同 sessionId+hash 的并发摘要 single-flight；同 hash 失败后记录失败
 *   缓存，不再请求模型，调用方直接走确定性裁剪；
 * - 摘要经 zod/长度/secret 过滤后 upsert；Checkpoint 非事实源，可随时重建。
 */

/** 摘要 schema 版本：结构变化时递增使全部旧 Checkpoint 失效。 */
export const CHECKPOINT_SCHEMA_VERSION = 1

/** 简易 secret 过滤：命中即整行丢弃（摘要不应承载凭据）。 */
const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{8,}|api[_-]?key\s*[:=]|authorization\s*[:=]|bearer\s+[A-Za-z0-9._-]{8,}|cookie\s*[:=]|token\s*[:=]\s*[A-Za-z0-9._-]{12,})/i

export function filterSecretLine(line: string): string | null {
  if (SECRET_PATTERN.test(line)) return null
  return line.trim() === '' ? null : line
}

export function sanitizeSummary(raw: unknown): ContextCheckpointSummary {
  const parsed = ContextCheckpointSummarySchema.safeParse(raw)
  if (!parsed.success) return emptySummary()
  const data = parsed.data
  const clean = (lines: string[]): string[] =>
    lines.map(filterSecretLine).filter((line): line is string => line !== null)
  return {
    goal: data.goal === null ? null : (filterSecretLine(data.goal) ?? null),
    constraints: clean(data.constraints),
    decisions: clean(data.decisions),
    completed: clean(data.completed),
    pending: clean(data.pending),
    toolFacts: clean(data.toolFacts),
    knownErrors: clean(data.knownErrors),
  }
}

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

/** 增量摘要 prompt 输入：旧摘要 → JSON；新增 Frame → 轻量 transcript。 */
function transcriptOf(frames: ContextFrame[]): string {
  const lines: string[] = []
  for (const frame of frames) {
    switch (frame.kind) {
      case 'user':
      case 'assistant_text':
        lines.push(
          `${frame.kind === 'user' ? 'user' : 'assistant'}: ${frame.content.slice(0, 400)}`,
        )
        break
      case 'tool_round': {
        if (frame.assistant.content !== '') {
          lines.push(`assistant: ${frame.assistant.content.slice(0, 200)}`)
        }
        for (const call of frame.assistant.toolCalls) {
          lines.push(`tool_call: ${call.name}`)
        }
        for (const result of frame.results) {
          lines.push(
            `tool_result: ${result.isError ? 'error' : 'ok'} ${result.content.slice(0, 200)}`,
          )
        }
        break
      }
      default:
        break
    }
  }
  return lines.join('\n').slice(0, 12_000)
}

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
/** 失败缓存：同 hash 在本进程内不再重试摘要。 */
const failedHashes = new Set<string>()

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
    existingRow.schemaVersion === CHECKPOINT_SCHEMA_VERSION
  ) {
    return {
      summary: existingRow.summary,
      sourceHash,
      hit: true,
      failed: false,
      summarized: false,
    }
  }
  if (existingRow !== null && existingRow.sourceHash !== sourceHash) {
    store.contextCheckpoints.delete(sessionId)
  }
  if (failedHashes.has(flightKey)) {
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
    const previousSummary =
      existingRow !== null &&
      existingRow.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
      existingRow.sourceHash !== sourceHash
        ? existingRow.summary
        : null
    const newFrames = sliceIncrementalFrames(
      stableFrames,
      options.stableIds,
      existingRow?.throughMessageId ?? null,
    )
    const raw = await options.summarize({
      previousSummary,
      newFrames,
      signal: options.signal,
    })
    const summary = sanitizeSummary(raw)
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
    if (error instanceof Error && error.name === 'AbortError') throw error
    failedHashes.add(flightKey)
    return {
      summary: emptySummary(),
      sourceHash,
      hit: false,
      failed: true,
      summarized: false,
    }
  }
}

/**
 * 增量切片：旧 Checkpoint watermark 之后的 Frame。
 * 旧 watermark 为 null 或在窗口中找不到 → 返回全部（全量重摘要）。
 */
function sliceIncrementalFrames(
  stableFrames: ContextFrame[],
  stableIds: (string | null)[] | undefined,
  watermark: string | null,
): ContextFrame[] {
  if (watermark === null || stableIds === undefined) return stableFrames
  // 从后往前找 watermark 的位置（稳定窗口尾部即 watermark 附近）。
  for (let i = stableIds.length - 1; i >= 0; i -= 1) {
    if (stableIds[i] === watermark) {
      return stableFrames.slice(i + 1)
    }
  }
  return stableFrames
}

/** 摘要自身的 token 估算（字段长度近似，供预算展示）。 */
function estimateSummaryTokens(summary: ContextCheckpointSummary): number {
  const count = (lines: string[]): number =>
    lines.reduce((sum, line) => sum + Math.ceil(line.length / 4), 0)
  return (
    (summary.goal === null ? 0 : Math.ceil(summary.goal.length / 4)) +
    count(summary.constraints) +
    count(summary.decisions) +
    count(summary.completed) +
    count(summary.pending) +
    count(summary.toolFacts) +
    count(summary.knownErrors)
  )
}

export { transcriptOf, summarizeCheckpointFrames }

/**
 * 结构化摘要调用（默认实现）：CHECKPOINT_SUMMARY_SYSTEM_PROMPT +
 * 旧摘要 JSON + 新增 Frame transcript，一次补全调用。
 */
async function summarizeCheckpointFrames(
  provider: ProviderRuntimeConfig,
  input: {
    previousSummary: ContextCheckpointSummary | null
    newFrames: ContextFrame[]
    signal: AbortSignal
  },
): Promise<unknown> {
  const { streamChatCompletion } = await import('../provider.js')
  const userPayload = [
    input.previousSummary === null
      ? '旧摘要：null（无既有摘要）'
      : `旧摘要：${JSON.stringify(input.previousSummary)}`,
    '新增对话片段：',
    transcriptOf(input.newFrames),
  ].join('\n\n')
  const result = await streamChatCompletion(
    {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [
        { role: 'system', content: CHECKPOINT_SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: userPayload },
      ],
      signal: input.signal,
      timeoutMs: provider.timeoutMs ?? 60_000,
      maxRetries: provider.maxRetries,
    },
    () => {},
  )
  // 模型可能包 markdown 代码块；提取第一段 JSON。
  const text = result.content.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('checkpoint summary: no JSON object in response')
  }
  return JSON.parse(text.slice(start, end + 1))
}
