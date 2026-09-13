/**
 * 终端输入通道（W3）：按键/粘贴合并 → 带序号批次 → 有界在飞窗口发送。
 * 语义（spec §4）：
 * - 16ms 定时器或 ≥8 KiB 原始字节触发批量 flush；粘贴无特殊处理（PTY 行规程）。
 * - 输入永不丢弃：窗口（≤4 批且 ≤32 KiB 原始字节）满时只 hold 缓冲区，
 *   用户至多在病态背压下看到输入停顿；窗口为空时限额豁免——单个超限
 *   批次（如接近 1 MiB 的粘贴）必须能发出，否则永久死锁。
 * - 序号 1-based、乐观分配：仅成功响应确认送达；确定性的
 *   backpressure/out_of_order 错误 → 同一批次 250ms 后重试一次（后端对
 *   seq≤已应用值幂等确认不重写，重试不会双写）；重试再失败或**请求超时**
 *   （状态未知，不自动重发）→ 通知「输入状态不确定」并挂起该终端的
 *   输入队列，等用户处置。
 */

import { utf8Length } from './binary'

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
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private halted = false

  constructor(private readonly options: TerminalInputChannelOptions) {
    this.lastSeq = options.seqBaseline ?? 0
  }

  isHalted(): boolean {
    return this.halted
  }

  /** 挂起后由用户显式恢复：从下一序号继续，不自动重发未知批次。 */
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
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.flushTimer = null
    this.retryTimer = null
    this.buffer = ''
    this.bufferBytes = 0
    this.inflight = []
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
        (sendError.code === 'terminal_input_backpressure' ||
          sendError.code === 'terminal_out_of_order')
      ) {
        batch.retried = true
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.dispatch(batch)
        }, RETRY_DELAY_MS)
        return
      }
      // 二次失败 / 超时（状态未知）/ 其他确定错误：挂起输入，等用户处置。
      this.halted = true
      this.inflight = []
      this.options.onHalt('输入状态不确定，请检查终端')
    }
  }

  private dropBatch(batch: InflightBatch): void {
    const index = this.inflight.indexOf(batch)
    if (index >= 0) this.inflight.splice(index, 1)
  }
}
