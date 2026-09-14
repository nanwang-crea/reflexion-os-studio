import type { ResourceEventEmitter } from '../events.js'

/**
 * 输出回传泵（spec §5.5 背压/公平调度）：
 * Rust 侧每个终端在 attach 前有界窗口（≤256 KiB，满即暂停 PTY 读），
 * TS 侧再有一层 egress 队列；两级窗口串联 → 每终端内存上界约 512 KiB。
 * 本模块把每个终端的 egress 帧按「轮询公平 + 令牌桶限速」合并成
 * terminal.output 事件发往前端，禁止逐帧直发导致的高频重渲染（AGENTS §11）。
 * 另含活动期指标（每 5s 一行字节/速率，绝不含内容，spec §8）。
 */

/** 单个待回传帧：seq 为 Rust 分配的输出序号，bytes 为原始 PTY 字节。 */
export interface EgressFrame {
  outputSeq: number
  bytes: Buffer
}

/** 一条终端的输出回传通道（挂在 TerminalRecord 上，供泵遍历）。 */
export interface EgressChannel {
  terminalId: string
  projectId: string
  /** 待回传帧队列（FIFO，按 outputSeq 递增）。 */
  queue: EgressFrame[]
  /** 当前队列内原始字节合计（配额/指标用）。 */
  queuedBytes: number
  /** 观测到的峰值队列字节（指标）。 */
  peakBytes: number
  /** 上一指标周期内累计发出的原始字节（速率指标，打印后清零）。 */
  emittedBytes: number
  /** 该终端的发射器（seq 在终端流内单调）。 */
  emitter: ResourceEventEmitter
  /** 事件 generation = TS 记录的 sidecar 代际；consumerId 缺省为 detached。 */
  generation: number
  consumerId?: string
}

/** 单帧合并上限（原始字节）。Rust 已把单帧截到 16 KiB，合并到 16 KiB 即为整块。 */
const COALESCE_RAW_LIMIT = 16 * 1024
/** 单条 terminal.output 事件的固定开销估算（信封字段 + JSON 标点，不含 base64 载荷）。 */
const EVENT_OVERHEAD = 200
/** 指标打印间隔（毫秒）。 */
const METRICS_INTERVAL_MS = 5_000
/** 空闲多久停指标（无回传活动）。 */
const METRICS_IDLE_MS = 5_000

/** base64 编码后字节数估算：ceil(raw*4/3)。 */
function encodedSize(raw: number): number {
  return Math.ceil((raw * 4) / 3)
}

/**
 * 令牌桶：以「编码字节」计。容量封顶为一个满合并事件，防止长期空闲攒出突发额度
 * 一次性打爆 WebView（AGENTS §11 合帧）。补充速率=预算均速。
 */
export class EgressPacer {
  private tokens: number
  private timer: NodeJS.Timeout | null = null
  private metricsTimer: NodeJS.Timeout | null = null
  private running = false
  private lastActivityAt = 0
  private readonly capacity: number
  /** 轮询游标：每轮从上一轮最后发出者之后开扫，防固定顺序饿死靠后的终端。 */
  private cursor = 0

  constructor(
    private readonly budgetBytesPerSec: number,
    private readonly tickMs: number,
    /** 全部通道快照（泵只处理队列非空者；指标扫描 emittedBytes/queue 非空者）。 */
    private readonly allChannels: () => EgressChannel[],
    /** 一轮 tick 结束后回调（服务用于把空闲的 pacer 关掉）。 */
    private readonly onTick: () => void,
  ) {
    // 容量至少容得下「一个满合并事件」，否则单个合法事件永远凑不齐令牌会死锁；
    // 补充速率仍严格等于 budgetBytesPerSec，长期均速受预算约束。
    const tickBytes = (budgetBytesPerSec * tickMs) / 1000
    this.capacity = Math.max(
      tickBytes,
      encodedSize(COALESCE_RAW_LIMIT) + EVENT_OVERHEAD,
    )
    this.tokens = this.capacity
  }

  /** 有新帧入队时调用：启动按需 tick 与活动期指标（定时器有界，AGENTS §11）。 */
  noteActivity(now = Date.now()): void {
    this.lastActivityAt = now
    if (!this.running) {
      this.running = true
      this.timer = setInterval(() => this.pump(), this.tickMs)
      this.timer.unref?.()
    }
    if (!this.metricsTimer) {
      this.metricsTimer = setInterval(() => this.report(), METRICS_INTERVAL_MS)
      this.metricsTimer.unref?.()
    }
  }

  /** 队列全空时由服务经 onTick 调用：关回传 tick（指标自会因空闲而停）。 */
  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 彻底停止（shutdown 路径）。 */
  halt(): void {
    this.stop()
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer)
      this.metricsTimer = null
    }
  }

  /** 每 tick 补充令牌并封顶（不攒突发额度）。 */
  private refill(): void {
    const tickBytes = (this.budgetBytesPerSec * this.tickMs) / 1000
    this.tokens = Math.min(this.capacity, this.tokens + tickBytes)
  }

  /**
   * 一轮泵：从轮询游标起环形遍历每个有积压的通道，各贡献「至多一个事件」。
   * 额度不足即本轮跳过该通道，帧留队到下个 tick
   * （Rust 在窗口上限暂停读 → 串联有界，绝不丢帧）。
   * 游标推进到最后发出者之后：W4 实测（16 终端洪泛）证明固定插入顺序开扫会让
   * 首个积压通道吞掉全部令牌、靠后通道整段窗口 +0B 饿死，轮询公平必须靠
   * 环形游标实现，而非只靠「每通道每轮至多一个事件」。
   */
  private pump(): void {
    this.refill()
    const channels = this.allChannels()
    const n = channels.length
    if (n > 0) {
      const start = this.cursor % n
      let lastServed = -1
      for (let i = 0; i < n; i += 1) {
        const index = (start + i) % n
        const channel = channels[index]
        if (channel.queue.length === 0) continue
        // 合并上限按整帧边界取（≥ 单帧），避免把一个 PTY 帧拆到两个事件里。
        const take = this.coalesceHead(channel)
        const cost = encodedSize(take) + EVENT_OVERHEAD
        if (cost > this.tokens) continue
        this.emitHead(channel, take)
        this.tokens -= cost
        lastServed = index
      }
      if (lastServed >= 0) this.cursor = (lastServed + 1) % n
    }
    this.onTick()
  }

  /** 计算队头可合并的原始字节（累加直到 COALESCE_RAW_LIMIT，至少整首帧）。 */
  private coalesceHead(channel: EgressChannel): number {
    let raw = 0
    for (const frame of channel.queue) {
      if (raw > 0 && raw + frame.bytes.length > COALESCE_RAW_LIMIT) break
      raw += frame.bytes.length
      if (raw >= COALESCE_RAW_LIMIT) break
    }
    return raw
  }

  /** 弹出队头共 take 原始字节，合并为一个 base64 事件发出（outputSeq=最后弹出帧）。 */
  private emitHead(channel: EgressChannel, take: number): void {
    const parts: Buffer[] = []
    let consumed = 0
    let lastSeq = channel.queue[0].outputSeq
    while (channel.queue.length > 0 && consumed < take) {
      const frame = channel.queue[0]
      const remaining = take - consumed
      if (frame.bytes.length <= remaining) {
        channel.queue.shift()
        parts.push(frame.bytes)
        consumed += frame.bytes.length
        lastSeq = frame.outputSeq
      } else {
        parts.push(frame.bytes.subarray(0, remaining))
        frame.bytes = frame.bytes.subarray(remaining)
        consumed += remaining
      }
    }
    channel.queuedBytes -= consumed
    channel.emittedBytes += consumed
    channel.emitter.next({
      type: 'terminal.output',
      terminalId: channel.terminalId,
      outputSeq: lastSeq,
      generation: channel.generation,
      consumerId: channel.consumerId ?? 'detached',
      data: Buffer.concat(parts).toString('base64'),
    })
  }

  /**
   * 收尾直发：关闭/退出时把剩余帧同步发出（绕过令牌桶），保证「尾部帧先于
   * closed/exited 状态」这一跨进程契约不被限速打乱。
   */
  flushChannel(channel: EgressChannel): void {
    while (channel.queue.length > 0) {
      const frame = channel.queue.shift() as EgressFrame
      channel.queuedBytes -= frame.bytes.length
      channel.emittedBytes += frame.bytes.length
      channel.emitter.next({
        type: 'terminal.output',
        terminalId: channel.terminalId,
        outputSeq: frame.outputSeq,
        generation: channel.generation,
        consumerId: channel.consumerId ?? 'detached',
        data: frame.bytes.toString('base64'),
      })
    }
  }

  /** 活动期指标：有积压或本周期发过字节的通道各打一行；长期空闲则自停。 */
  private report(): void {
    if (Date.now() - this.lastActivityAt > METRICS_IDLE_MS) {
      if (this.metricsTimer) clearInterval(this.metricsTimer)
      this.metricsTimer = null
      return
    }
    for (const channel of this.allChannels()) {
      if (channel.queue.length === 0 && channel.emittedBytes === 0) continue
      process.stderr.write(
        `[terminal-metrics] ${channel.terminalId} queued=${channel.queuedBytes} peak=${channel.peakBytes} emitted=${channel.emittedBytes}\n`,
      )
      channel.emittedBytes = 0
    }
  }
}
