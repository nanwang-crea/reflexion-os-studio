import { checkpointSummaryHasContent } from './checkpoint/summary.js'
import { formatCheckpointBlock } from './checkpoint/format.js'
import { contextBudgetFor, type ProviderRuntimeConfig } from './budget.js'
import {
  FrameError,
  type ContextFrame,
  type ModelMessage,
  boundFramesForModel,
  estimateFrameTokens,
  estimateMessageTokens,
  framesToMessages,
  messagesToFrames,
} from '@reflexion-os-studio/agent-core'
import type { Store } from '../../store/index.js'
import type { ToolSpec } from '@reflexion-os-studio/contracts'
import { buildInstructionBlock } from '../instructions/render.js'
import {
  framesToValidatedMessages,
  reconstructSessionFramesWithIds,
} from './context-frames.js'
import {
  CHECKPOINT_SCHEMA_VERSION,
  computeSourceHash,
  ensureCheckpoint,
  summarizeCheckpointFrames,
} from './context-checkpoint.js'

/** Recent tools remain atomic; background refresh cadence is unchanged. */
export const KEEP_RECENT_FRAMES = 8
export const CHECKPOINT_REFRESH_FRAME_THRESHOLD = 8
export { contextBudgetFor, DEFAULT_CONTEXT_BUDGET_LIMIT } from './budget.js'
export type { ProviderRuntimeConfig } from './budget.js'

/**
 * 轮内工作集收敛：仅做确定性 Frame 裁剪，不发起隐藏模型调用。调用方必须把
 * 返回值写回 Agent 循环基线，确保后续轮次不会反复处理已淘汰历史。工具轮保持
 * 原子性；转换出悬空引用时按序列校验失败处理，不发送 Provider。
 */
export function compactInRun(
  messages: ModelMessage[],
  provider: ProviderRuntimeConfig,
  tools: readonly ToolSpec[] = [],
): ModelMessage[] {
  const budget = contextBudgetFor(provider, tools)
  let frames: ContextFrame[]
  try {
    frames = messagesToFrames(messages)
  } catch (error) {
    if (error instanceof FrameError) {
      process.stderr.write(
        `[runtime] in-run frame conversion failed, refusing provider request: ${error.message}\n`,
      )
    }
    throw error
  }
  if (estimateFrameTokens(frames) <= budget) {
    return messages
  }
  return framesToValidatedMessages(
    boundFramesForModel(frames, budget, KEEP_RECENT_FRAMES),
  )
}

/** 诊断指标（§17.1）：单行 JSON 写 stderr；hash 只记录短前缀，不含正文。 */
function emitContextMetrics(
  sessionId: string,
  metrics: Record<string, unknown>,
): void {
  const payload: string[] = [`sessionId:${sessionId.slice(0, 8)}`]
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== undefined) payload.push(`${key}:${String(value)}`)
  }
  process.stderr.write(`[metrics] ${payload.join(' ')}\n`)
}

/** 会话历史的重建与压缩；Run 启动时由 runner 调用一次。 */
export class ContextBuilder {
  constructor(private readonly store: Store) {}

  /** Phase 3A 子 Agent 上下文：不读取父历史、AGENTS.md、MEMORY.md 或 checkpoint。 */
  buildIsolated(sessionId: string, systemPrompt: string): ModelMessage[] {
    const { frames } = reconstructSessionFramesWithIds(
      this.store,
      sessionId,
      systemPrompt,
    )
    return framesToValidatedMessages(frames)
  }

  /**
   * 从 canonical 存储重建 Frame 历史（system + 指令/记忆块 → Checkpoint → 最近
   * Frame）。超预算时优先复用已持久化的 Checkpoint，并把水位线后的历史原样
   * 带入；摘要缺失或累计到阈值时在后台刷新。当前请求从不等待摘要模型，缺少
   * 可用 Checkpoint 时直接走确定性 Frame 裁剪。
   * 本地数据损坏（FrameError）直接失败为 internal，不降级。
   */
  async build(
    sessionId: string,
    systemPrompt: string,
    provider: ProviderRuntimeConfig,
    signal: AbortSignal,
    tools: readonly ToolSpec[] = [],
  ): Promise<ModelMessage[]> {
    const buildStartedAt = Date.now()
    // 指令/记忆文件注入（文件即记忆 V2）：失败/为空都不影响对话。
    const instructionBlock = await buildInstructionBlock(
      this.store,
      sessionId,
    ).catch(() => '')
    const effectiveSystem =
      instructionBlock === ''
        ? systemPrompt
        : `${systemPrompt}\n\n${instructionBlock}`
    const { frames, messageIds } = reconstructSessionFramesWithIds(
      this.store,
      sessionId,
      effectiveSystem,
    )
    const budget = contextBudgetFor(provider, tools)
    if (estimateFrameTokens(frames) <= budget) {
      emitContextMetrics(sessionId, {
        contextBuildMs: Date.now() - buildStartedAt,
        checkpointHit: false,
        compactionCalls: 0,
      })
      return framesToValidatedMessages(frames)
    }
    // 超预算：切分稳定/最近窗口（Frame 边界，工具轮不拆）。
    const head = frames[0]?.kind === 'system' ? 1 : 0
    const body = frames.slice(head)
    const bodyIds = messageIds.slice(head)
    const keep = Math.min(KEEP_RECENT_FRAMES, body.length)
    const stable = body.slice(0, body.length - keep)
    const stableIds = bodyIds.slice(0, stable.length)
    const recent = body.slice(body.length - keep)
    const throughMessageId =
      [...stableIds].reverse().find((id) => id !== null) ?? null
    const existing = this.store.contextCheckpoints.get(sessionId)
    const watermarkIndex =
      existing === null ? -1 : stableIds.lastIndexOf(existing.throughMessageId)
    const checkpointValid =
      existing !== null &&
      existing.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
      watermarkIndex >= 0 &&
      computeSourceHash(stable.slice(0, watermarkIndex + 1)) ===
        existing.sourceHash &&
      checkpointSummaryHasContent(existing.summary)
    const suffix = checkpointValid ? body.slice(watermarkIndex + 1) : recent
    const shouldRefresh =
      !checkpointValid ||
      stable.length - (watermarkIndex + 1) >= CHECKPOINT_REFRESH_FRAME_THRESHOLD

    if (shouldRefresh) {
      // 后台更新只写缓存，不参与本轮首字关键路径。摘要失败时保留旧 checkpoint，
      // 让后续请求仍可复用；同 source hash 的失败由服务层在进程内去重。
      void ensureCheckpoint({
        store: this.store,
        sessionId,
        provider,
        summarize: (input) => summarizeCheckpointFrames(provider, input),
        stableFrames: stable,
        stableIds,
        throughMessageId,
        signal,
      }).catch((error) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          process.stderr.write(
            `[runtime] background checkpoint refresh failed: ${String(error)}\n`,
          )
        }
      })
    }

    const assembled: ContextFrame[] = checkpointValid
      ? [
          {
            kind: 'system',
            content:
              `${frames[0]?.kind === 'system' ? frames[0].content : ''}\n\n${formatCheckpointBlock(existing.summary)}`.trim(),
          },
          ...suffix,
        ]
      : frames
    const messages = framesToValidatedMessages(
      boundFramesForModel(assembled, budget, KEEP_RECENT_FRAMES),
    )
    emitContextMetrics(sessionId, {
      contextBuildMs: Date.now() - buildStartedAt,
      checkpointHit: checkpointValid,
      checkpointSourceHash: checkpointValid
        ? existing.sourceHash.slice(0, 8)
        : undefined,
      compactionCalls: 0,
      checkpointRefreshScheduled: shouldRefresh,
      deterministicTrim: !checkpointValid,
    })
    return messages
  }

  /** 当前历史的 token 估算，暴露给诊断与未来预算策略。 */
  estimate(sessionId: string, systemPrompt: string): number {
    return estimateMessageTokens(
      framesToMessages(
        reconstructSessionFramesWithIds(this.store, sessionId, systemPrompt)
          .frames,
      ),
    )
  }
}
