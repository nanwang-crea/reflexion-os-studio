import { FailureTracker } from './failure-tracker.js'
import type { FailureTrackingPolicy } from './failure-tracker.js'
import { createHash } from 'node:crypto'
import type { ToolCallRequest, ToolResult } from './types.js'

/**
 * 四次相同结果或同资源同类失败后先返回恢复提示；忽略提示重放才终止。
 * 成功的非幂等变更立即拒绝原样重放，防止重复副作用。
 * freshness epoch 在成功变更、计划变化或用户新消息后递增。
 */
export class LoopGuard {
  private readonly failures: FailureTracker
  private epoch = 0
  private readonly repetitions = new Map<
    string,
    { digest: string; count: number }
  >()
  private readonly recoveryWarnings = new Set<string>()
  /** 基础指纹 → 已执行或结果不明的 mutation 绑定的新 epoch。 */
  private readonly protectedMutations = new Map<string, number>()
  /** 基础指纹 → 连续被拦截次数（duplicate → no_progress 传导）。 */
  private readonly blockedMutations = new Map<string, number>()

  constructor(policy: FailureTrackingPolicy = {}) {
    this.failures = new FailureTracker(policy)
  }

  /** fresh epoch：mutation 成功、Plan 变化、用户新消息后调用。 */
  bumpEpoch(): void {
    this.advanceEpoch()
    this.failures.clear()
  }

  currentEpoch(): number {
    return this.epoch
  }

  /** 完整指纹：工具名 + canonicalJson(args) + epoch。 */
  fingerprint(request: ToolCallRequest): string {
    return `${baseFingerprint(request)}:${this.epoch}`
  }

  /** 模型可见结果摘要（调用方传入截断后的结果文本，不含 secret）。 */
  resultDigest(result: ToolResult): string {
    return `${result.isError ? 'error' : 'ok'}:${result.code ?? ''}:${createHash('sha256').update(result.content).digest('hex')}`
  }

  /**
   * 执行前判定。allow 允许执行；block 拒绝并给出稳定工具错误码。
   * 调用方随后必须调用 recordExecution/recordBlocked。
   */
  admit(request: ToolCallRequest): {
    verdict: 'allow' | 'block'
    code?: string
    message?: string
    terminal?: boolean
  } {
    if (this.failures.exhausted(request)) {
      return this.noProgress(
        this.recoveryKey(request),
        '同一操作与资源已累计四次出现同类错误。不要继续原样重试；依据错误调整策略，或向用户说明当前阻碍。',
      )
    }
    const base = baseFingerprint(request)
    // 已执行或结果不明 mutation 的完全相同重放：freshness 未因其它原因推进 → 拦截。
    const boundEpoch = this.protectedMutations.get(base)
    if (boundEpoch === this.epoch) {
      if (this.blockedMutations.get(base) ?? 0) {
        // duplicate_side_effect 已回传过一次，模型仍重复 → no_progress。
        return {
          verdict: 'block',
          code: 'no_progress',
          terminal: true,
          message:
            '该调用已执行或结果不明，且模型在收到重复副作用警告后仍发起相同调用，已停止执行。',
        }
      }
      return {
        verdict: 'block',
        code: 'duplicate_side_effect',
        message: `该调用已执行或结果不明，且环境未发生变化（freshness epoch ${this.epoch}），重复执行可能产生重复副作用。请先检查实际结果；不要通过无关操作绕过重复保护。`,
      }
    }
    const repetition = this.repetitions.get(this.fingerprint(request))
    if (repetition !== undefined && repetition.count >= 4) {
      return this.noProgress(
        this.recoveryKey(request),
        '同一调用已连续四次返回相同结果。此调用未再次执行；请改变策略、等待有依据的状态变化，或向用户说明结果，不要原样重试。',
      )
    }
    return { verdict: 'allow' }
  }

  /** 执行后记录：相同完整指纹 + 相同摘要的重复会累计。 */
  recordExecution(
    request: ToolCallRequest,
    result: ToolResult,
    mutation: boolean,
    protectReplay = mutation,
  ): { repeated: boolean } {
    this.failures.record(request, result, mutation)
    const fp = this.fingerprint(request)
    const digest = this.resultDigest(result)
    const previous = this.repetitions.get(fp)
    const repeated = previous?.digest === digest
    this.repetitions.set(fp, {
      digest,
      count: repeated ? previous.count + 1 : 1,
    })
    if (mutation && (!result.isError || result.replayUnsafe)) {
      // 成功或结果不明的 mutation 绑定新 epoch；只读核对不解除重放保护。
      // 立即重放被拦（duplicate），其它原因推进 epoch 后重跑视为新鲜。
      this.advanceEpoch()
      if (protectReplay)
        this.protectedMutations.set(baseFingerprint(request), this.epoch)
    }
    return { repeated }
  }

  /** 记录被拦截的调用（不执行）。duplicate 重复出现传导为 no_progress。 */
  recordBlocked(request: ToolCallRequest): void {
    if (this.failures.exhausted(request)) {
      this.recoveryWarnings.add(this.recoveryKey(request))
      return
    }
    const base = baseFingerprint(request)
    if (this.protectedMutations.get(base) === this.epoch) {
      this.blockedMutations.set(
        base,
        (this.blockedMutations.get(base) ?? 0) + 1,
      )
      return
    }
    this.recoveryWarnings.add(this.recoveryKey(request))
  }

  private recoveryKey(request: ToolCallRequest): string {
    return this.failures.exhausted(request)
      ? `failure:${this.epoch}:${this.failures.key(request)}`
      : this.fingerprint(request)
  }

  private advanceEpoch(): void {
    this.epoch += 1
    this.repetitions.clear()
    this.recoveryWarnings.clear()
    this.protectedMutations.clear()
    this.blockedMutations.clear()
  }

  private noProgress(key: string, message: string) {
    return {
      verdict: 'block' as const,
      code: 'no_progress',
      terminal: this.recoveryWarnings.has(key),
      message: this.recoveryWarnings.has(key)
        ? `收到无进展提示后仍重复调用，已停止执行。${message}`
        : message,
    }
  }
}

/** 基础指纹：工具名 + canonicalJson(args)（不含 epoch）。 */
function baseFingerprint(request: ToolCallRequest): string {
  let args: string
  try {
    args = `json:${canonicalJson(JSON.parse(request.arguments.trim() === '' ? '{}' : request.arguments))}`
  } catch {
    args = `raw:${request.arguments}`
  }
  return `${request.name}:${createHash('sha256').update(args).digest('hex')}`
}

/** 对对象 key 排序的 canonical JSON；数组保持原顺序。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
  return `{${entries.join(',')}}`
}
