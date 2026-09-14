import { CommandError } from '../agent/errors.js'
import { EmitterRegistry, type EventNotifier } from '../events.js'
import { SystemRuntimeError } from '../system.js'
import type { Terminal, TerminalStatus } from '@reflexion-os-studio/contracts'
import type { EgressChannel } from './egress.js'

export interface TerminalServiceConfig {
  attachTimeoutMs: number
  createTimeoutMs: number
  egressTickMs: number
  egressBudgetBytesPerSec: number
  maxActivePerProject: number
  maxActiveGlobal: number
  maxRetained: number
  /** closed 记录 TTL：过期后在 create 时清扫出索引（spec §5 closed 不长期保留）。 */
  closedRetentionMs: number
  /** 单输入批次解码字节上限（spec §6）；前端按同值切批，此处为 Runtime 层守卫。 */
  inputBatchMaxBytes: number
  inputPendingMax: number
  inputGapWaitMs: number
}

export const DEFAULTS: TerminalServiceConfig = {
  attachTimeoutMs: 10_000,
  createTimeoutMs: 8_000,
  egressTickMs: 16,
  egressBudgetBytesPerSec: 1_048_576,
  maxActivePerProject: 8,
  maxActiveGlobal: 16,
  maxRetained: 32,
  closedRetentionMs: 60_000,
  inputBatchMaxBytes: 8 * 1024,
  inputPendingMax: 4,
  inputGapWaitMs: 200,
}

export const ACTIVE: ReadonlySet<TerminalStatus> = new Set([
  'starting',
  'running',
  'closing',
])
export const TERMINAL: ReadonlySet<TerminalStatus> = new Set([
  'exited',
  'closed',
  'failed',
  'disconnected',
])
/**
 * 留存额度口径（终审 #1，spec §5）：只有 exited/failed/disconnected 占
 * maxRetained——closed 不是可见标签（前端不复挂），只按 closedRetentionMs
 * 短暂驻留后清扫，计入额度会让「关了还报留存已满」违背常识。
 */
export const RETAINED: ReadonlySet<TerminalStatus> = new Set([
  'exited',
  'failed',
  'disconnected',
])

/** 缓冲的乱序输入：写请求挂起等待补齐（resolve）或间隙过期/关闭（reject）。 */
export interface PendingInput {
  data: string
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

export function createPendingInput(data: string): PendingInput {
  const set: { resolve: () => void; reject: (error: Error) => void } = {
    resolve: () => {},
    reject: () => {},
  }
  const promise = new Promise<void>((resolve, reject) => {
    set.resolve = () => resolve()
    set.reject = (error: Error) => reject(error)
  })
  return { data, promise, resolve: set.resolve, reject: set.reject }
}

export interface TerminalRecord {
  meta: Terminal
  consumerId?: string
  attached: boolean
  channel: EgressChannel
  ackedThrough: number
  appliedInputSeq: number
  pendingInputs: Map<number, PendingInput>
  attachTimer?: NodeJS.Timeout
  /** 间隙过期计时器：每记录一个，覆盖最旧的待定缺口（spec §5 输入序号）。 */
  gapTimer?: NodeJS.Timeout
  /** 间隙已过期：期望 seq 到达前，一切乱序写立即拒绝（稳定码窗口）。 */
  inputGapDropped: boolean
  /** exited 回收已发起（Rust close 已发）：后续 closed 通知吞掉，不再重复发。 */
  rustReclaimed?: boolean
  /** 失败/异常原因（前 200 字符，仅诊断，不含内容）：failed 事件携带。 */
  errorMessage?: string
  /** 进入 closed 的时刻（epoch ms）：TTL 清扫判据（终审 #1，spec §5）。 */
  closedAtMs?: number
}

export interface IdempotencyEntry {
  terminalId: string
  storedAt: number
  promise?: Promise<Terminal>
}

/**
 * Rust 稳定码 → 前端契约码映射（终审 #2）：**首选** SystemRuntimeError.code
 * （Rust error.data.code 经 SystemRuntimeClient 结构化透传）；仅当错误不带
 * 结构化码（遗留单测 fake、非 JSON-RPC 故障路径如写管道失败）才退化为
 * message 子串扫描——legacy 兜底，不再是主通路。未知归 internal。
 */
const RUST_CODE_MAP: ReadonlyMap<string, string> = new Map([
  // W4-2b：Rust 有界输入队列满快拒（input_backpressure）→ 前端契约码
  // terminal_input_backpressure（input-channel.ts 的 definite 退避重试臂）。
  // 这是唯一 Rust 码 ≠ 前端码的映射，其余身份透传。
  ['input_backpressure', 'terminal_input_backpressure'],
  ['terminal_closed', 'terminal_closed'],
  ['io_error', 'io_error'],
  ['pty_error', 'pty_error'],
  ['too_many_terminals', 'too_many_terminals'],
  ['invalid_request', 'invalid_request'],
])

export function rustErrorCode(error: unknown): string {
  if (error instanceof SystemRuntimeError && error.code !== undefined) {
    const mapped = RUST_CODE_MAP.get(error.code)
    if (mapped !== undefined) return mapped
    // 结构化码不在 Rust terminal 稳定码表内：继续走 legacy 子串兜底。
  }
  // legacy 兜底（终审 #2 前的唯一通路）：错误无结构化码时按 message 子串还原。
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('input_backpressure')) {
    return 'terminal_input_backpressure'
  }
  for (const code of [
    'terminal_closed',
    'io_error',
    'pty_error',
    'too_many_terminals',
    'invalid_request',
  ]) {
    if (message.includes(code)) return code
  }
  return 'internal'
}

export function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timeout/i.test(message)
}

/**
 * 终端记录索引：records / byProject / createKeys 三张表 + 配额统计 +
 * 发射器缓存。纯数据/索引职责，不含协议行为（行为在 TerminalService）。
 */
export class RecordIndex {
  readonly records = new Map<string, TerminalRecord>()
  readonly byProject = new Map<string, Set<string>>()
  readonly createKeys = new Map<string, IdempotencyEntry>()
  readonly emitters: EmitterRegistry

  constructor(notifier: EventNotifier) {
    this.emitters = new EmitterRegistry(notifier)
  }

  emitterFor(projectId: string, terminalId: string) {
    return this.emitters.for({ scope: 'terminal', projectId, terminalId })
  }

  add(record: TerminalRecord): void {
    this.records.set(record.meta.terminalId, record)
    let set = this.byProject.get(record.meta.projectId)
    if (!set) {
      set = new Set()
      this.byProject.set(record.meta.projectId, set)
    }
    set.add(record.meta.terminalId)
  }

  get(terminalId: string): TerminalRecord | undefined {
    return this.records.get(terminalId)
  }

  /** 项目作用域查找：跨项目/不存在一律 terminal_not_found（不泄露他项目终端存在性）。 */
  mustFind(projectId: string, terminalId: string): TerminalRecord {
    const record = this.records.get(terminalId)
    if (!record || record.meta.projectId !== projectId) {
      throw new CommandError(
        'terminal_not_found',
        `terminal ${terminalId} not found in project ${projectId}`,
      )
    }
    return record
  }

  projectIds(projectId: string): Set<string> | undefined {
    return this.byProject.get(projectId)
  }

  list(projectId: string): Terminal[] {
    const ids = this.byProject.get(projectId)
    if (!ids) return []
    const out: Terminal[] = []
    for (const terminalId of ids) {
      const record = this.records.get(terminalId)
      if (record) out.push({ ...record.meta })
    }
    return out
  }

  remove(terminalId: string): void {
    const record = this.records.get(terminalId)
    if (!record) return
    this.records.delete(terminalId)
    this.byProject.get(record.meta.projectId)?.delete(terminalId)
    this.emitters.evict({
      scope: 'terminal',
      projectId: record.meta.projectId,
      terminalId,
    })
  }

  /** requestId 幂等表 TTL 60s（已定型的条目才扫，in-flight 保留）。 */
  sweepIdempotency(now: number): void {
    const cutoff = now - 60_000
    for (const [key, entry] of this.createKeys) {
      if (entry.storedAt < cutoff && !entry.promise) this.createKeys.delete(key)
    }
  }

  activeChannels(): EgressChannel[] {
    const out: EgressChannel[] = []
    for (const record of this.records.values()) {
      if (record.channel.queue.length > 0) out.push(record.channel)
    }
    return out
  }

  quotaCounts(projectId: string): {
    projectActive: number
    globalActive: number
    retained: number
  } {
    let projectActive = 0
    let globalActive = 0
    let retained = 0
    for (const record of this.records.values()) {
      const status = record.meta.status
      if (ACTIVE.has(status)) {
        globalActive += 1
        if (record.meta.projectId === projectId) projectActive += 1
      } else if (RETAINED.has(status)) {
        // closed 刻意排除（终审 #1）：不可见、待 TTL 清扫，不占留存额度。
        retained += 1
      }
    }
    return { projectActive, globalActive, retained }
  }
}
