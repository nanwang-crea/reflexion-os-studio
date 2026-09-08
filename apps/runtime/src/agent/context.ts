import {
  FrameError,
  type ContextFrame,
  type ModelMessage,
  boundFramesForModel,
  compactFrames,
  estimateFrameTokens,
  estimateMessageTokens,
  framesToMessages,
  messagesToFrames,
} from '@reflexion-os-studio/agent-core'
import type { Store } from '../store/index.js'
import { streamChatCompletion } from '../provider.js'
import { buildMemoryBlock } from './memory/recall.js'
import { HISTORY_COMPACTOR_SYSTEM_PROMPT } from './prompts/index.js'
import {
  framesToValidatedMessages,
  reconstructSessionFrames,
} from './context-frames.js'

/**
 * 上下文预算上限（token 数）：超过即触发摘要压缩。
 * 模型窗口更大时仍以该值为上限；可在 Provider 设置中按供应商标定。
 */
export const DEFAULT_CONTEXT_BUDGET_LIMIT = 64_000

/** 压缩时始终原样保留的最近 Frame 数（工具轮整体计一，不拆分）。 */
export const KEEP_RECENT_FRAMES = 8

export interface ProviderRuntimeConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 缺省由服务端决定。 */
  temperature?: number
  maxTokens?: number
  /** 模型上下文窗口（token 数）；未知时用预算上限。 */
  contextWindow?: number
  /** 上下文预算上限（token 数）；缺省 DEFAULT_CONTEXT_BUDGET_LIMIT。 */
  contextBudget?: number
  /** 请求建立阶段重试次数；缺省 provider 内置(5)。 */
  maxRetries?: number
  /** 请求超时(毫秒)；缺省 provider 内置(120s)。 */
  timeoutMs?: number
}

/**
 * 上下文预算：min(预算上限, 窗口 × 0.75 − maxTokens 预留),为输出留足空间;
 * 下限 1024 防止小配置把预算压死。窗口未知时直接用预算上限。
 */
export function contextBudgetFor(provider: ProviderRuntimeConfig): number {
  const limit = provider.contextBudget ?? DEFAULT_CONTEXT_BUDGET_LIMIT
  const window = provider.contextWindow
  if (window === undefined || window === null || window <= 0) {
    return limit
  }
  const outputReserve = provider.maxTokens ?? 0
  const windowBudget = Math.floor(window * 0.75) - outputReserve
  return Math.max(1024, Math.min(limit, windowBudget))
}

/**
 * 一组 Frame 的模型摘要（启动压缩用）：HISTORY_COMPACTOR_SYSTEM_PROMPT +
 * transcript，一次补全调用。输入为 Frame 投影的消息序列。
 */
export function summarizeFrames(
  provider: ProviderRuntimeConfig,
  stableFrames: ContextFrame[],
  signal: AbortSignal,
): Promise<string> {
  const transcript = framesToMessages(stableFrames)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')
  return streamChatCompletion(
    {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      messages: [
        { role: 'system', content: HISTORY_COMPACTOR_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      signal,
      timeoutMs: provider.timeoutMs ?? 60_000,
      maxRetries: provider.maxRetries,
    },
    () => {},
  ).then((result) => result.content)
}

/**
 * 轮内压缩管线：把循环内存消息流转为 Frame 后按预算压缩。
 * 超预算 → 模型摘要压缩窗口外 Frame（信息保留优先，工具轮不拆）；
 * 摘要失败或仍超 → 零成本 Frame 裁剪兜底。每轮最多一次摘要调用；
 * 摘要失败写 stderr 并降级，绝不阻塞对话。转换出悬空引用（循环 bug
 * 或损坏数据）时按序列校验失败处理，不发送 Provider。
 */
export async function compactInRun(
  messages: ModelMessage[],
  provider: ProviderRuntimeConfig,
  signal: AbortSignal,
): Promise<ModelMessage[]> {
  const budget = contextBudgetFor(provider)
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
  try {
    const { frames: compacted } = await compactFrames({
      frames,
      budgetTokens: budget,
      keepRecentFrames: KEEP_RECENT_FRAMES,
      summarize: (stable) => summarizeFrames(provider, stable, signal),
    })
    return framesToValidatedMessages(boundFramesForModel(compacted, budget))
  } catch (error) {
    if (error instanceof FrameError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw error
    process.stderr.write(
      `[runtime] in-run compaction failed, falling back to frame trimming: ${String(error)}\n`,
    )
    return framesToValidatedMessages(boundFramesForModel(frames, budget))
  }
}

/** 会话历史的重建与压缩；Run 启动时由 runner 调用一次。 */
export class ContextBuilder {
  constructor(private readonly store: Store) {}

  /**
   * 从 canonical 存储重建 Frame 历史（system + 记忆块 → 摘要 → 最近 Frame），
   * 超出预算时用压缩 prompt 做一次静默摘要调用；摘要失败则退化为 Frame 裁剪，
   * 不阻塞对话。本地数据损坏（FrameError）直接失败为 internal，不降级。
   */
  async build(
    sessionId: string,
    systemPrompt: string,
    provider: ProviderRuntimeConfig,
    signal: AbortSignal,
  ): Promise<ModelMessage[]> {
    // A2 Memory 召回：失败/为空都不影响对话，只是没有记忆块。
    const memoryBlock = await buildMemoryBlock(this.store, sessionId).catch(
      () => '',
    )
    const effectiveSystem =
      memoryBlock === '' ? systemPrompt : `${systemPrompt}\n\n${memoryBlock}`
    const frames = reconstructSessionFrames(
      this.store,
      sessionId,
      effectiveSystem,
    )
    const budget = contextBudgetFor(provider)
    try {
      const { frames: compacted } = await compactFrames({
        frames,
        budgetTokens: budget,
        keepRecentFrames: KEEP_RECENT_FRAMES,
        summarize: (stable) => summarizeFrames(provider, stable, signal),
      })
      return framesToValidatedMessages(
        boundFramesForModel(compacted, budget, KEEP_RECENT_FRAMES),
      )
    } catch (error) {
      if (error instanceof FrameError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw error
      // 摘要失败（网络/Provider 异常）不拦任务：退化为确定性 Frame 裁剪。
      process.stderr.write(
        `[runtime] context compaction failed, falling back to frame trimming: ${String(error)}\n`,
      )
      return framesToValidatedMessages(
        boundFramesForModel(frames, budget, KEEP_RECENT_FRAMES),
      )
    }
  }

  /** 当前历史的 token 估算，暴露给诊断与未来预算策略。 */
  estimate(sessionId: string, systemPrompt: string): number {
    return estimateMessageTokens(
      framesToMessages(
        reconstructSessionFrames(this.store, sessionId, systemPrompt),
      ),
    )
  }
}
