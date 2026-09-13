/**
 * 终端输入通道（W3）：按键/粘贴合并 → 带序号批次 → 有界在飞窗口发送。
 * 语义（spec §4）：
 * - 16ms 定时器或 ≥8 KiB 原始字节触发批量 flush；粘贴无特殊处理（PTY 行规程）。
 * - 输入永不丢弃：窗口（≤4 批且 ≤32 KiB 原始字节）满时只 hold 缓冲区，
 *   用户至多在病态背压下看到输入停顿；窗口为空时限额豁免——单个超限
 *   批次（如接近 1 MiB 的粘贴）必须能发出，否则永久死锁。
 * - 序号 1-based、乐观分配：仅成功响应确认送达。确定性 backpressure
 *   错误 → 同一批次 250ms 后重试一次（后端对 seq≤已应用值幂等确认不重写，
 *   重试不会双写）；确定性 out_of_order 错误 → **不重试**立即挂起——它
 *   意味着更早的批次已丢失在飞，序号缺口未愈合时重发同一 seq 只会被继续
 *   拒绝；重试再失败或**请求超时**（状态未知，不自动重发）→ 通知「输入
 *   状态不确定」并挂起该终端的输入队列；halt 唯一出口是关闭标签重建。
 */

import { utf8Length } from './binary'

/** 挂起（不可自动恢复）统一文案：唯一出口是关闭标签重建终端。 */
export const INPUT_HALT_MESSAGE =
  '输入状态不确定，该终端输入已暂停；请关闭此标签后重新创建。'
/** out_of_order 专用挂起文案：更早批次已丢失在飞，防重复执行。 */
export const INPUT_OUT_OF_ORDER_MESSAGE =
  '终端输入顺序中断，为防重复执行已暂停该终端输入；请关闭此标签后重新创建。'

/** 发送失败分类：definite=收到明确错误回执（可安全重试一次）；uncertain=超时等未知状态。 */
export class InputSendError extends Error {
  constructor(
    readonly kind: 'definite' | 'uncertain',
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'InputSendError'
  }
}

const FLUSH_INTERVAL_MS = 16
const FLUSH_BATCH_BYTES = 8 * 1024
const INFLIGHT_MAX_BATCHES = 4
const INFLIGHT_MAX_BYTES = 32 * 1024
const RETRY_DELAY_MS = 250

interface InflightBatch {
  seq: number
  bytes: Uint8Array
  retried: boolean
  /** 该批次专属的重试定时器：单槽位会被后到的重试覆盖，导致先前的批次永久滞留。 */
  retryTimer: ReturnType<typeof setTimeout> | null
}

export interface TerminalInputChannelOptions {
  /** 发送一个带序号批次；失败抛 InputSendError。 */
  send: (seq: number, bytes: Uint8Array) => Promise<void>
  /** 队列挂起（不可自动恢复）时的一次性通知入口。 */
  onHalt: (message: string) => void
  /** 后端输入序号基线：首个批次 seq = baseline + 1（Runtime 侧基线为 0）。 */
  seqBaseline?: number
}

export class TerminalInputChannel {
  private buffer = ''
  private bufferBytes = 0
  private inflight: InflightBatch[] = []
  /** 已乐观分配的最大序号（下一个批次 = lastSeq + 1）。 */
  private lastSeq: number
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private halted = false

  constructor(private readonly options: TerminalInputChannelOptions) {
    this.lastSeq = options.seqBaseline ?? 0
  }

  isHalted(): boolean {
    return this.halted
  }

  /**
   * 不可接线：后端 gap 缓冲语义下乐观跳号会造成输入被吞；halt 唯一出口是
   * 关闭标签重建终端。保留本方法仅作为语义说明，调用点必须保持为零。
   */
  resume(): void {
    if (!this.halted) return
    this.halted = false
    this.scheduleFlush(0)
  }

  /** xterm onData / 粘贴入口：data 为 UTF-8 文本（含控制序列）。 */
  push(data: string): void {
    if (this.halted || data.length === 0) return
    this.buffer += data
    this.bufferBytes += utf8Length(data)
    if (this.bufferBytes >= FLUSH_BATCH_BYTES) this.flushBuffer()
    else this.scheduleFlush(FLUSH_INTERVAL_MS)
  }

  dispose(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.buffer = ''
    this.bufferBytes = 0
    this.clearInflight()
  }

  private scheduleFlush(ms: number): void {
    if (this.flushTimer !== null || this.buffer.length === 0) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushBuffer()
    }, ms)
  }

  private windowFull(): boolean {
    if (this.inflight.length === 0) return false // 空窗口豁免超限大批次
    if (this.inflight.length >= INFLIGHT_MAX_BATCHES) return true
    const bytes = this.inflight.reduce(
      (sum, batch) => sum + batch.bytes.length,
      0,
    )
    return bytes >= INFLIGHT_MAX_BYTES
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return
    if (this.windowFull()) {
      this.scheduleFlush(FLUSH_INTERVAL_MS) // hold，不丢弃
      return
    }
    const raw = new TextEncoder().encode(this.buffer)
    this.buffer = ''
    this.bufferBytes = 0
    this.lastSeq += 1
    const batch: InflightBatch = {
      seq: this.lastSeq,
      bytes: raw,
      retried: false,
      retryTimer: null,
    }
    this.inflight.push(batch)
    void this.dispatch(batch)
  }

  private async dispatch(batch: InflightBatch): Promise<void> {
    try {
      await this.options.send(batch.seq, batch.bytes)
      this.dropBatch(batch)
      // 窗口腾出后继续刷剩余缓冲。
      this.flushBuffer()
    } catch (error) {
      const sendError =
        error instanceof InputSendError
          ? error
          : new InputSendError('uncertain', 'unknown', String(error))
      if (
        sendError.kind === 'definite' &&
        !batch.retried &&
        sendError.code === 'terminal_input_backpressure'
      ) {
        batch.retried = true
        // 定时器挂在批次上：单槽位字段会被后到的重试覆盖，
        // 导致先发起重试的那批永久滞留在 inflight（静默输入冻结）。
        batch.retryTimer = setTimeout(() => {
          batch.retryTimer = null
          void this.dispatch(batch)
        }, RETRY_DELAY_MS)
        return
      }
      // 二次失败 / 超时（状态未知）/ out_of_order / 其他确定错误：挂起输入。
      // out_of_order 表示更早批次已丢失在飞，重发同一 seq 只会被继续拒绝，
      // 故不重试直接 halt；halt 唯一出口是关闭标签重建（见 resume() 注释）。
      this.halted = true
      this.clearInflight()
      this.options.onHalt(
        sendError.kind === 'definite' &&
          sendError.code === 'terminal_input_out_of_order'
          ? INPUT_OUT_OF_ORDER_MESSAGE
          : INPUT_HALT_MESSAGE,
      )
    }
  }

  /** 清空在飞集合，并逐一清掉其挂起的重试定时器（不留单槽位）。 */
  private clearInflight(): void {
    for (const batch of this.inflight) {
      if (batch.retryTimer !== null) clearTimeout(batch.retryTimer)
      batch.retryTimer = null
    }
    this.inflight = []
  }

  private dropBatch(batch: InflightBatch): void {
    if (batch.retryTimer !== null) {
      clearTimeout(batch.retryTimer)
      batch.retryTimer = null
    }
    const index = this.inflight.indexOf(batch)
    if (index >= 0) this.inflight.splice(index, 1)
  }
}
