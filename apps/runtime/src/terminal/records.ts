import { CommandError } from '../agent/errors.js'
import { EmitterRegistry, type EventNotifier } from '../events.js'
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
}

export interface IdempotencyEntry {
  terminalId: string
  storedAt: number
  promise?: Promise<Terminal>
}

/** 从 Rust JSON-RPC error 文本中还原稳定 code（passthrough），未知归 internal。 */
export function rustErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
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
      } else if (TERMINAL.has(status)) {
        retained += 1
      }
    }
    return { projectActive, globalActive, retained }
  }
}
