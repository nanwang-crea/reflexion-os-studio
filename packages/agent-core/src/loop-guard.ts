import { createHash } from 'node:crypto'
import type { ToolCallRequest, ToolResult } from './types.js'

/**
 * Loop Guard（W4）：识别重复调用与无进展循环。
 *
 * 指纹与摘要：
 * - 基础指纹 = 工具名 + canonicalJson(args)；完整指纹 = 基础指纹 + freshnessEpoch。
 * - resultDigest = status + errorCode + 模型可见结果哈希。
 *
 * freshness epoch 在以下事件后递增：mutation（write/shell/state）成功、
 * Plan 状态变化、用户发送新消息。因此"修改代码后重跑同一测试"是新指纹。
 *
 * 无进展规则（§8.2）：
 * - 相同完整只读指纹连续两次执行且结果摘要相同 → 第 3 次前注入一次反思；
 *   第 3 次不再执行，Run 以 no_progress 失败；
 * - 摘要不同（结果变化）视为进展，重新计数；
 * - 已成功的 mutation 立即拦截完全相同的重放（duplicate_side_effect），
 *   直到 freshness 因其它原因推进；模型仍重复一次则 no_progress。
 */
export class LoopGuard {
  private epoch = 0
  /** 完整指纹 → 执行次数。 */
  private readonly seen = new Map<string, number>()
  /** 完整指纹 → 最近两次结果摘要（判定无进展用）。 */
  private readonly digestHistory = new Map<
    string,
    [string | undefined, string | undefined]
  >()
  /** 基础指纹 → 成功 mutation 绑定的 epoch（自身成功后的新 epoch）。 */
  private readonly successfulMutations = new Map<string, number>()
  /** 基础指纹 → 连续被拦截次数（duplicate → no_progress 传导）。 */
  private readonly blockedMutations = new Map<string, number>()

  /** fresh epoch：mutation 成功、Plan 变化、用户新消息后调用。 */
  bumpEpoch(): void {
    this.epoch += 1
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
  } {
    const base = baseFingerprint(request)
    // 已成功 mutation 的完全相同重放：freshness 未因其它原因推进 → 拦截。
    const boundEpoch = this.successfulMutations.get(base)
    if (boundEpoch !== undefined) {
      if (this.blockedMutations.get(base) ?? 0) {
        // duplicate_side_effect 已回传过一次，模型仍重复 → no_progress。
        return {
          verdict: 'block',
          code: 'no_progress',
          message:
            '该调用已成功执行过，且模型在收到重复副作用警告后仍发起相同调用，已停止执行。',
        }
      }
      if (boundEpoch === this.epoch) {
        return {
          verdict: 'block',
          code: 'duplicate_side_effect',
          message: `该调用已成功执行且环境未发生变化（freshness epoch ${this.epoch}），重复执行可能产生重复副作用。如确需重做，请先修改文件、执行其它变更或调整计划。`,
        }
      }
    }
    const fp = this.fingerprint(request)
    const count = this.seen.get(fp) ?? 0
    if (count >= 2) {
      const history = this.digestHistory.get(fp)
      if (
        history !== undefined &&
        history[0] !== undefined &&
        history[0] === history[1]
      ) {
        // 两次执行结果摘要完全相同：无进展。
        return {
          verdict: 'block',
          code: 'no_progress',
          message:
            '检测到同一调用连续重复且结果无变化，已停止执行以避免无限循环。',
        }
      }
    }
    return { verdict: 'allow' }
  }

  /** 执行后记录：相同完整指纹 + 相同摘要的重复会累计。 */
  recordExecution(
    request: ToolCallRequest,
    result: ToolResult,
    mutation: boolean,
  ): { repeated: boolean } {
    const fp = this.fingerprint(request)
    const digest = this.resultDigest(result)
    const count = this.seen.get(fp) ?? 0
    this.seen.set(fp, count + 1)
    const history = this.digestHistory.get(fp) ?? [undefined, undefined]
    const repeated = history[1] !== undefined && history[1] === digest
    this.digestHistory.set(fp, [history[1], digest])
    if (mutation && !result.isError) {
      // mutation 成功：绑定"成功后的新 epoch"并推进——
      // 立即重放被拦（duplicate），其它原因推进 epoch 后重跑视为新鲜。
      this.successfulMutations.set(baseFingerprint(request), this.epoch + 1)
      this.blockedMutations.delete(baseFingerprint(request))
      this.epoch += 1
    }
    return { repeated }
  }

  /** 记录被拦截的调用（不执行）。duplicate 重复出现传导为 no_progress。 */
  recordBlocked(request: ToolCallRequest): void {
    const base = baseFingerprint(request)
    if (this.successfulMutations.has(base)) {
      this.blockedMutations.set(
        base,
        (this.blockedMutations.get(base) ?? 0) + 1,
      )
      return
    }
    const fp = this.fingerprint(request)
    this.seen.set(fp, (this.seen.get(fp) ?? 0) + 1)
  }
}

/** 基础指纹：工具名 + canonicalJson(args)（不含 epoch）。 */
function baseFingerprint(request: ToolCallRequest): string {
  return `${request.name}:${createHash('sha256')
    .update(canonicalJson(parseLoose(request.arguments)))
    .digest('hex')}`
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

function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text.trim() === '' ? '{}' : text)
  } catch {
    return { __unparsed: text.slice(0, 64) }
  }
}
