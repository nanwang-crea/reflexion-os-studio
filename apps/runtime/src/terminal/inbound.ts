import type { TerminalStatus } from '@reflexion-os-studio/contracts'
import type { EgressPacer } from './egress.js'
import { TERMINAL, type RecordIndex, type TerminalRecord } from './records.js'
import { transitionStatus } from './state.js'

/**
 * Rust → TS 通知接线：把 terminal.output / terminal.state 通知落到对应记录，
 * 做代际过滤与跨进程顺序保持，然后转交回传泵或状态机。职责单一，便于测试。
 * 依赖注入 RecordIndex（查记录）与 EgressPacer（入队/冲刷）。
 */
export class InboundProcessor {
  constructor(
    private readonly index: RecordIndex,
    private readonly pacer: EgressPacer,
    /** Rust exited 后的额度回收回调（发 Rust close 释放会话表槽位）。 */
    private readonly onRustExited: (record: TerminalRecord) => void,
  ) {}

  handle(method: string, params: unknown): void {
    const payload = (params ?? {}) as Record<string, unknown>
    const terminalId = payload.terminalId
    if (typeof terminalId !== 'string') return
    const record = this.index.get(terminalId)
    if (!record) {
      process.stderr.write(`[terminal] drop ${method}: unknown ${terminalId}\n`)
      return
    }
    // 旧代际事件丢弃：Rust generation 与记录代际不符即视为重启前的迟到帧。
    if (
      typeof payload.generation === 'number' &&
      payload.generation !== record.meta.generation
    ) {
      process.stderr.write(
        `[terminal] drop ${method}: stale generation ${payload.generation} != ${record.meta.generation}\n`,
      )
      return
    }
    if (method === 'terminal.output') {
      this.enqueueOutput(record, payload)
      return
    }
    if (method === 'terminal.state') this.applyRustState(record, payload)
  }

  private enqueueOutput(
    record: TerminalRecord,
    payload: Record<string, unknown>,
  ): void {
    const { outputSeq, data } = payload
    if (typeof outputSeq !== 'number' || typeof data !== 'string') return
    const bytes = Buffer.from(data, 'base64')
    record.channel.queue.push({ outputSeq, bytes })
    record.channel.queuedBytes += bytes.length
    record.channel.peakBytes = Math.max(
      record.channel.peakBytes,
      record.channel.queuedBytes,
    )
    this.pacer.noteActivity()
  }

  private applyRustState(
    record: TerminalRecord,
    payload: Record<string, unknown>,
  ): void {
    const status = payload.status as TerminalStatus | undefined
    // Rust 只发 running|exited|closed（其余由 TS 合成）。
    if (status !== 'running' && status !== 'exited' && status !== 'closed')
      return
    const exitCode =
      typeof payload.exitCode === 'number' || payload.exitCode === null
        ? (payload.exitCode as number | null)
        : undefined
    if (status === 'running') {
      transitionStatus(record, 'running')
      return
    }
    // 额度回收（#2）：TS 在 exited 后已自发 Rust close 释放会话表槽位，
    // 这条 close 的 closed 回执不得覆盖「exited + exitCode」的展示契约
    // （spec §2），整条通知吞掉（无事件、无降级）。
    if (
      status === 'closed' &&
      record.meta.status === 'exited' &&
      record.rustReclaimed
    ) {
      return
    }
    // exited/closed：Rust 已保证尾帧先于状态；冲刷本侧残留队列再发状态事件。
    this.pacer.flushChannel(record.channel)
    if (exitCode !== undefined && !TERMINAL.has(record.meta.status)) {
      record.meta.exitCode = exitCode
    }
    const changed = transitionStatus(record, status)
    // 只有真实发生 →exited 迁移才回收：重复 exited 首次已触发；closed 后
    // 迟到的 exited 早被吸收，其 Rust 槽位也已被 close 释放。
    if (status === 'exited' && changed) this.onRustExited(record)
  }
}
