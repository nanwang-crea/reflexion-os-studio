import { ackTerminal } from '../../api/terminal'
import type { TerminalInstance } from './types'

/**
 * 输出确认水位（W3）：每 100ms 合并刷一次，`pendingHighest > lastSent`
 * 才发 `terminal.ack`（throughOutputSeq 累计确认）；单终端同一时刻至多
 * 一条 ack 在飞。ack 失败（终端已消失等）也前移水位：它只是额度释放
 * 信号，对死终端重发没有意义还会形成死循环。定时器按需启停
 * （AGENTS §11：空闲零负载）。
 */
const FLUSH_INTERVAL_MS = 100

export class AckTracker {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly instances: () => Iterable<TerminalInstance>) {}

  /** xterm write 回调 / 缓冲丢弃点调用：推进待确认水位。 */
  noteConsumed(inst: TerminalInstance, outputSeq: number): void {
    if (outputSeq > inst.ack.pendingHighest) {
      inst.ack.pendingHighest = outputSeq
      this.schedule()
    }
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_INTERVAL_MS)
  }

  private flush(): void {
    for (const inst of this.instances()) {
      const ack = inst.ack
      if (ack.inFlight || ack.pendingHighest <= ack.lastSent) continue
      const through = ack.pendingHighest
      ack.inFlight = true
      ackTerminal(inst.projectId, inst.meta.terminalId, through)
        .catch((error: unknown) => {
          console.debug('[terminal] ack failed', error)
        })
        .finally(() => {
          ack.inFlight = false
          if (through > ack.lastSent) ack.lastSent = through
          if (ack.pendingHighest > ack.lastSent) this.schedule()
        })
    }
  }
}
