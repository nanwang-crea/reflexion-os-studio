import { CommandError } from '../agent/errors.js'
import {
  createPendingInput,
  type TerminalRecord,
  type TerminalServiceConfig,
} from './records.js'

/**
 * 输入序号串行化与间隙裁决（spec §5）：期望 seq 直发 Rust；乱序 seq 缓冲挂起
 * 等补齐（每记录一个过期计时器，config.inputGapWaitMs）。过期即整批丢弃并
 * 进入「丢弃窗口」：期望 seq 到达前一切乱序写以稳定码
 * terminal_input_out_of_order 立即拒绝——自愈规则：前端下一批必带 expected
 * seq，它一落地即清除窗口状态。缓冲挂在写请求上（应答随补齐或拒绝）。
 */
export class InputOrder {
  constructor(
    private readonly config: TerminalServiceConfig,
    private readonly rustWrite: (
      record: TerminalRecord,
      data: string,
    ) => Promise<void>,
  ) {}

  async write(
    record: TerminalRecord,
    inputSeq: number,
    data: string,
  ): Promise<{ accepted: true; inputSeq: number }> {
    if (inputSeq <= record.appliedInputSeq) {
      return { accepted: true, inputSeq } // 重复/旧序号：确认但不重发。
    }
    const expected = record.appliedInputSeq + 1
    // 间隙已过期：期望 seq 到达前一切乱序写立即拒绝（稳定码窗口）。
    if (inputSeq !== expected && record.inputGapDropped) {
      throw new CommandError(
        'terminal_input_out_of_order',
        `input gap: expected ${expected}, got ${inputSeq}`,
      )
    }
    if (inputSeq === expected) {
      await this.rustWrite(record, data)
      record.appliedInputSeq = inputSeq
      record.inputGapDropped = false
      await this.flushPending(record)
      return { accepted: true, inputSeq }
    }
    if (record.pendingInputs.size >= this.config.inputPendingMax) {
      throw new CommandError(
        'terminal_input_backpressure',
        '输入乱序缓冲已满，前端须重排/退避',
      )
    }
    // 乱序写挂起等补齐：间隙在 inputGapWaitMs 内被填上则随刷出应答，
    // 过期则被 terminal_input_out_of_order 拒绝（spec §5 明确拒绝乱序/过量）。
    const pending = createPendingInput(data)
    record.pendingInputs.set(inputSeq, pending)
    this.armGapTimer(record)
    await pending.promise
    return { accepted: true, inputSeq }
  }

  /** 清空并拒绝全部缓冲写（间隙过期 / 关闭 / 断开），避免悬挂 promise。 */
  failPendingInputs(record: TerminalRecord, error: Error): void {
    this.clearGapTimer(record)
    const pending = [...record.pendingInputs.values()]
    record.pendingInputs.clear()
    record.inputGapDropped = false
    for (const item of pending) item.reject(error)
  }

  private async flushPending(record: TerminalRecord): Promise<void> {
    // applied 前进后，把连续可发序号按序刷出；某次失败即断链（抛出），保留其余缓冲。
    for (;;) {
      const next = record.appliedInputSeq + 1
      const pending = record.pendingInputs.get(next)
      if (pending === undefined) break
      await this.rustWrite(record, pending.data)
      record.pendingInputs.delete(next)
      record.appliedInputSeq = next
      pending.resolve()
    }
    if (record.pendingInputs.size === 0) this.clearGapTimer(record)
  }

  /** 每记录一个间隙计时器：只对最旧待定缺口 arm，过期整批丢弃。 */
  private armGapTimer(record: TerminalRecord): void {
    if (record.gapTimer) return
    // 故意不 unref：挂起的写请求以本计时器为唯一裁决，unref 会让事件在
    // 空闲进程里永不落地；一次性且 ≤ inputGapWaitMs，close/断开路径必清。
    record.gapTimer = setTimeout(() => {
      record.gapTimer = undefined
      this.discardGappedInputs(record)
    }, this.config.inputGapWaitMs)
  }

  private clearGapTimer(record: TerminalRecord): void {
    if (record.gapTimer) {
      clearTimeout(record.gapTimer)
      record.gapTimer = undefined
    }
  }

  private discardGappedInputs(record: TerminalRecord): void {
    const dropped = record.pendingInputs.size
    if (dropped === 0) return
    const terminalId = record.meta.terminalId
    const expected = record.appliedInputSeq + 1
    this.failPendingInputs(
      record,
      new CommandError(
        'terminal_input_out_of_order',
        `input gap expired: resend from ${expected}`,
      ),
    )
    record.inputGapDropped = true
    // 指标行只记 terminalId + 丢弃数，绝不含输入内容（spec §9）。
    process.stderr.write(
      `[terminal] input-gap-expired terminal=${terminalId} dropped=${dropped} expected=${expected}\n`,
    )
  }
}
