import { randomUUID } from 'node:crypto'
import { CommandError } from '../agent/errors.js'
import type { EventNotifier } from '../events.js'
import type { SystemRuntimeClient } from '../system.js'
import type { Terminal } from '@reflexion-os-studio/contracts'
import { EgressPacer, type EgressChannel } from './egress.js'
import { InboundProcessor } from './inbound.js'
import { InputOrder } from './input-order.js'
import {
  DEFAULTS,
  RecordIndex,
  TERMINAL,
  isTimeoutError,
  rustErrorCode,
  type TerminalRecord,
  type TerminalServiceConfig,
} from './records.js'
import { enforceQuota, sweepClosedRecords } from './quota.js'
import { emitState, transitionStatus } from './state.js'

export type { TerminalServiceConfig } from './records.js'
export { RecordIndex } from './records.js'

export interface TerminalServiceDeps {
  getProject: (id: string) => { folderPath: string } | null | undefined
  system: Pick<SystemRuntimeClient, 'request' | 'currentGeneration'>
  notify: EventNotifier
  config?: Partial<TerminalServiceConfig>
}

/**
 * 终端多会话服务：幂等创建 / 配额 / 输入序号串行化 / 输出公平调度回传 /
 * Rust 通知接线 / 回收与降级。状态机见 spec §5，跨进程顺序契约见 §5.5。
 * 索引/幂等在 RecordIndex，额度裁决与 closed TTL 清扫在 quota.ts，
 * 回传限速/合并在 EgressPacer，通知在 InboundProcessor，输入序号与间隙在
 * InputOrder，状态迁移在 state.ts，本类只做编排。
 */
export class TerminalService {
  private readonly config: TerminalServiceConfig
  private readonly index: RecordIndex
  private readonly pacer: EgressPacer
  private readonly inbound: InboundProcessor
  private readonly inputOrder: InputOrder

  constructor(private readonly deps: TerminalServiceDeps) {
    this.config = { ...DEFAULTS, ...deps.config }
    this.index = new RecordIndex(deps.notify)
    this.pacer = new EgressPacer(
      this.config.egressBudgetBytesPerSec,
      this.config.egressTickMs,
      () => [...this.index.records.values()].map((r) => r.channel),
      () => {
        if (this.index.activeChannels().length === 0) this.pacer.stop()
      },
    )
    this.inputOrder = new InputOrder(this.config, (record, data) =>
      this.rustWrite(record, data),
    )
    this.inbound = new InboundProcessor(this.index, this.pacer, (record) =>
      this.reclaimRust(record),
    )
  }

  /** Rust 上推通知入口（terminal.output / terminal.state）。 */
  handleRustNotification(method: string, params: unknown): void {
    this.inbound.handle(method, params)
  }

  list(projectId: string): Terminal[] {
    return this.index.list(projectId)
  }

  // ---------------- 生命周期 ----------------

  async create(
    requestId: string,
    projectId: string,
    rows: number,
    cols: number,
  ): Promise<{ terminal: Terminal }> {
    const now = Date.now()
    this.index.sweepIdempotency(now)
    sweepClosedRecords(this.index, this.config, now)
    const existing = this.index.createKeys.get(requestId)
    if (existing) {
      // 同 requestId：in-flight → 共享同一 spawn promise（并发只起一个 shell）；
      // 已定 → 返回留存记录 meta（含 failed，绝不重生，见 runSpawn 上方语义注释）。
      if (existing.promise) return { terminal: await existing.promise }
      const record = this.index.get(existing.terminalId)
      if (record) return { terminal: { ...record.meta } }
      this.index.createKeys.delete(requestId)
    }
    const project = this.deps.getProject(projectId)
    if (!project || !project.folderPath) {
      throw new CommandError(
        'project_not_found',
        `project not found: ${projectId}`,
      )
    }
    enforceQuota(this.index, this.config, projectId)
    const terminalId = randomUUID()
    const meta: Terminal = {
      terminalId,
      projectId,
      initialCwd: project.folderPath,
      shellArgv: [],
      rows,
      cols,
      status: 'starting',
      generation: this.deps.system.currentGeneration,
      createdAt: new Date().toISOString(),
    }
    const channel: EgressChannel = {
      terminalId,
      projectId,
      queue: [],
      queuedBytes: 0,
      peakBytes: 0,
      emittedBytes: 0,
      emitter: this.index.emitterFor(projectId, terminalId),
      generation: meta.generation,
    }
    const record: TerminalRecord = {
      meta,
      attached: false,
      channel,
      ackedThrough: -1,
      // 输入序号 1-based：baseline 0 表示「尚未应用任何输入，下一个期望 seq=1」。
      appliedInputSeq: 0,
      pendingInputs: new Map(),
      inputGapDropped: false,
    }
    this.index.add(record)
    // starting 是记录创建态，显式发一次事件（transitionStatus 会因同值去重而吞掉）。
    emitState(record, 'starting')
    // 存 in-flight promise 于 await 之前，保证并发/超时后的重试命中同一 terminalId。
    const promise = this.runSpawn(record, project.folderPath)
    this.index.createKeys.set(requestId, {
      terminalId,
      storedAt: Date.now(),
      promise,
    })
    try {
      const terminal = await promise
      return { terminal: { ...terminal } }
    } finally {
      const entry = this.index.createKeys.get(requestId)
      if (entry && entry.terminalId === terminalId) entry.promise = undefined
    }
  }

  /**
   * 幂等 in-flight 语义（CAREFUL，spec §5）：key 在 spawn 之前落表；并发同
   * requestId 共享同一 promise → 只 spawn 一次、同一 terminalId。spawn 超时/失败
   * 后记录以 failed 留存且**保留 key**：用户以同 requestId 重试会拿到 failed meta
   * 而非重开 shell（避免超时幽灵 shell + 新 shell 双开）；换新终端须用新 requestId。
   */
  private async runSpawn(
    record: TerminalRecord,
    cwd: string,
  ): Promise<Terminal> {
    const { terminalId } = record.meta
    try {
      const result = (await this.deps.system.request(
        'terminal.spawn',
        { terminalId, cwd, rows: record.meta.rows, cols: record.meta.cols },
        { timeoutMs: this.config.createTimeoutMs },
      )) as { generation?: number; shellArgv?: string[] }
      record.meta.generation = result.generation ?? record.meta.generation
      record.channel.generation = record.meta.generation
      // spec §4：shell 由 Rust 裁决（default_shell_argv），元数据贯通回传；
      // 旧 sidecar 缺字段时保留现值（不覆盖为空）。
      record.meta.shellArgv = result.shellArgv ?? record.meta.shellArgv
      // Rust 成功即刻同步 emit running（去重：若 running 通知先到，此处不重复发）。
      transitionStatus(record, 'running')
      this.armAttachTimer(record)
      return record.meta
    } catch (error) {
      if (isTimeoutError(error)) {
        // 幂等 close 兜底：spawn 请求超时≠shell 没起；晚到的幽灵 shell 会占额度，
        // 这里 fire-and-forget 一个 close（Rust close 幂等）把它回收，避免僵尸。
        void this.closeGhost(terminalId)
      }
      transitionStatus(record, 'failed', {
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      // 终审 #2：Rust 稳定码（pty_error/too_many_terminals/…）经 SystemRuntimeError
      // 结构化透传后映射为同码 CommandError——不包装则 create 落 index.ts 的
      // internal 兜底，前端 notices 映射（pty_error 等）永远不可达。
      // Rust 侧 create-time 额度满（too_many_terminals）在 TS 配额下正常不发生，
      // 发生时同样如实上报。
      throw new CommandError(
        rustErrorCode(error),
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async closeGhost(terminalId: string): Promise<void> {
    try {
      await this.deps.system.request('terminal.close', { terminalId })
    } catch {
      // 幽灵未起或已 gone：close 报错可忽略。
    }
  }

  /**
   * #2 exited 额度回收：Rust 会话表（硬上限 16）含 exited-not-closed，
   * TS active 额度不含 → 16 个 exited 标签页会饿死新 spawn。shell 已死即
   * fire-and-forget 一个 close（幂等）释放表槽位；其 closed 回执由
   * rustReclaimed 守卫吞掉，meta 展示契约（exited + exitCode）不变（spec §2）。
   */
  private reclaimRust(record: TerminalRecord): void {
    if (record.rustReclaimed) return
    record.rustReclaimed = true
    void this.deps.system
      .request('terminal.close', { terminalId: record.meta.terminalId })
      .catch(() => {
        // 回收失败一律吞：sidecar 重启会自然清表；额度真满的信号仍是
        // Rust 的 too_many_terminals。
      })
  }

  /** 僵尸保护 + 额度释放（spec §5.5）：超时未 attach 的 running 终端自动关闭并计 failed。 */
  private armAttachTimer(record: TerminalRecord): void {
    const timer = setTimeout(() => {
      record.attachTimer = undefined
      if (record.attached || record.meta.status !== 'running') return
      // fire-and-forget 关 Rust 侧 shell（幂等，回收额度），本地直接标 failed。
      void this.closeGhost(record.meta.terminalId)
      transitionStatus(record, 'failed', {
        errorMessage: 'attach timeout (zombie protection)',
      })
    }, this.config.attachTimeoutMs)
    timer.unref?.()
    record.attachTimer = timer
  }

  async attach(
    projectId: string,
    terminalId: string,
    consumerId: string,
  ): Promise<{ terminal: Terminal; replayedBytes: number }> {
    const record = this.index.mustFind(projectId, terminalId)
    if (record.meta.status !== 'starting' && record.meta.status !== 'running') {
      throw new CommandError(
        'terminal_not_running',
        `terminal ${terminalId} 不可 attach`,
      )
    }
    const result = (await this.deps.system.request('terminal.attach', {
      terminalId,
      consumerId,
    })) as { replayedBytes?: number }
    record.attached = true
    record.consumerId = consumerId
    record.channel.consumerId = consumerId
    this.clearAttachTimer(record)
    return {
      terminal: { ...record.meta },
      replayedBytes: result.replayedBytes ?? 0,
    }
  }

  async write(
    projectId: string,
    terminalId: string,
    inputSeq: number,
    data: string,
  ): Promise<{ accepted: true; inputSeq: number }> {
    const record = this.index.mustFind(projectId, terminalId)
    if (record.meta.status !== 'running') {
      throw new CommandError(
        'terminal_not_running',
        `terminal ${terminalId} 非 running`,
      )
    }
    // spec §6「单输入批次 ≤8 KiB」的 Runtime 层（终审 #3，三层之一）：前端
    // input-channel flush 时已切 ≤8 KiB，正常流量不会命中；此为防御性硬校验，
    // 超限批次绝不入队/转发 Rust（Rust 入队前还有同值终检）。
    if (
      Buffer.from(data, 'base64').byteLength > this.config.inputBatchMaxBytes
    ) {
      throw new CommandError(
        'terminal_input_batch_too_large',
        `input batch exceeds ${this.config.inputBatchMaxBytes} bytes`,
      )
    }
    return this.inputOrder.write(record, inputSeq, data)
  }

  private async rustWrite(record: TerminalRecord, data: string): Promise<void> {
    try {
      await this.deps.system.request('terminal.write', {
        terminalId: record.meta.terminalId,
        data,
      })
    } catch (error) {
      throw new CommandError(
        rustErrorCode(error),
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  async resize(
    projectId: string,
    terminalId: string,
    rows: number,
    cols: number,
  ): Promise<{ rows: number; cols: number }> {
    const record = this.index.mustFind(projectId, terminalId)
    if (record.meta.status !== 'running') {
      throw new CommandError(
        'terminal_not_running',
        `terminal ${terminalId} 非 running`,
      )
    }
    const result = (await this.deps.system.request('terminal.resize', {
      terminalId,
      rows,
      cols,
    })) as { rows?: number; cols?: number }
    record.meta.rows = result.rows ?? rows
    record.meta.cols = result.cols ?? cols
    return { rows: record.meta.rows, cols: record.meta.cols }
  }

  async ack(
    projectId: string,
    terminalId: string,
    throughOutputSeq: number,
  ): Promise<{ ok: true }> {
    const record = this.index.mustFind(projectId, terminalId)
    if (throughOutputSeq <= record.ackedThrough) return { ok: true }
    record.ackedThrough = throughOutputSeq
    try {
      await this.deps.system.request('terminal.ack', {
        terminalId,
        throughOutputSeq,
      })
    } catch (error) {
      // 终端已消失：ack 无意义，吞掉 terminal_closed（终审 #2：稳定码经
      // SystemRuntimeError.data.code 存活，rustErrorCode 优先读结构化码）。
      const code = rustErrorCode(error)
      if (code !== 'terminal_closed') {
        throw new CommandError(
          code,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    return { ok: true }
  }

  async close(
    projectId: string,
    terminalId: string,
  ): Promise<{ closed: true }> {
    const record = this.index.mustFind(projectId, terminalId)
    await this.doClose(record, true)
    return { closed: true }
  }

  private async doClose(
    record: TerminalRecord,
    throwOnError: boolean,
  ): Promise<void> {
    // 仅当已 closed 时幂等短路；exited/failed/disconnected 仍允许走关闭收敛为 closed。
    if (record.meta.status === 'closed') return
    if (record.meta.status === 'exited' && record.rustReclaimed) {
      // #2 回收语义：Rust close 已随 exited 回收发出（幂等，不二次调用）；
      // tab 即将从前端消失，不重发 closing/closed 事件——exited + exitCode
      // 是回收路径的展示契约（spec §2），发 closed 只会造成状态闪烁。
      // 本地静默收敛为 closed，仅清计时器与回传/缓冲残留。
      record.meta.status = 'closed'
      record.closedAtMs = Date.now() // transitionStatus 未参与本路径，TTL 起点就地记（终审 #1）
      this.pacer.flushChannel(record.channel)
      this.clearAttachTimer(record)
      this.inputOrder.failPendingInputs(
        record,
        new CommandError('terminal_closed', 'terminal closed'),
      )
      return
    }
    const wasDisconnected = record.meta.status === 'disconnected'
    transitionStatus(record, 'closing', { force: true })
    const terminalId = record.meta.terminalId
    // disconnected 意味着 sidecar 已重启、PTY 已死：不再向 Rust 发 close（会抛
    // not-available），直接本地收敛。
    if (!wasDisconnected) {
      try {
        await this.deps.system.request('terminal.close', { terminalId })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `[terminal] close ${terminalId} error: ${message}\n`,
        )
        if (throwOnError) throw new CommandError(rustErrorCode(error), message)
      }
    }
    // 尾部帧先于 closed 状态发出（跨进程顺序契约）。
    this.pacer.flushChannel(record.channel)
    this.clearAttachTimer(record)
    this.inputOrder.failPendingInputs(
      record,
      new CommandError('terminal_closed', 'terminal closed'),
    )
    transitionStatus(record, 'closed', { force: true })
  }

  /**
   * 项目删除前回收其全部终端（spec §2）：任一 close 出错即抛
   * terminal_cleanup_failed 且**不删项目**（避免留下无主 shell）。
   */
  async closeProject(projectId: string): Promise<void> {
    const ids = this.index.projectIds(projectId)
    if (!ids || ids.size === 0) return
    const errors: string[] = []
    for (const terminalId of [...ids]) {
      const record = this.index.get(terminalId)
      if (!record) continue
      try {
        await this.doClose(record, true)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (errors.length > 0) {
      throw new CommandError(
        'terminal_cleanup_failed',
        `终端回收失败，保留项目: ${errors.join('; ')}`,
      )
    }
    for (const terminalId of [...ids]) this.index.remove(terminalId)
  }

  /** sidecar 重启后 PTY 已死；不自动重跑（spec §2）。返回受影响记录数。 */
  markAllDisconnected(reason: string): number {
    let count = 0
    for (const record of this.index.records.values()) {
      if (TERMINAL.has(record.meta.status)) continue
      record.channel.queue = []
      record.channel.queuedBytes = 0
      this.clearAttachTimer(record)
      this.inputOrder.failPendingInputs(
        record,
        new CommandError('terminal_closed', `system runtime ${reason}`),
      )
      transitionStatus(record, 'disconnected', {
        errorMessage: `system runtime ${reason}`,
      })
      count += 1
    }
    return count
  }

  async shutdown(): Promise<void> {
    this.pacer.halt()
    const closing: Promise<void>[] = []
    for (const record of this.index.records.values()) {
      if (TERMINAL.has(record.meta.status)) continue
      closing.push(this.doClose(record, false))
    }
    // ~900ms 上限：超时后强制标记，Rust close_all + Host kill 作兜底。
    await Promise.race([
      Promise.all(closing).then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 900)
        timer.unref?.()
      }),
    ])
    for (const record of this.index.records.values()) {
      if (!TERMINAL.has(record.meta.status)) {
        this.clearAttachTimer(record)
        transitionStatus(record, 'closed', { force: true })
      }
    }
  }

  // ---------------- 工具 ----------------

  private clearAttachTimer(record: TerminalRecord): void {
    if (record.attachTimer) {
      clearTimeout(record.attachTimer)
      record.attachTimer = undefined
    }
  }
}
