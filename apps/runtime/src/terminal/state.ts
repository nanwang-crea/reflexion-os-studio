import type { TerminalStatus } from '@reflexion-os-studio/contracts'
import { TERMINAL, type TerminalRecord } from './records.js'

export interface StatusExtra {
  exitCode?: number | null
  errorMessage?: string
  /** force：仅用户 close（exited→closed 收敛）等命令路径使用，绕过终态吸收。 */
  force?: boolean
}

/** 发一条 terminal.state 事件（不含迁移判断）：seq 在终端流内单调。 */
export function emitState(
  record: TerminalRecord,
  status: TerminalStatus,
  errorMessage?: string,
): void {
  const event: Record<string, unknown> = {
    type: 'terminal.state',
    terminalId: record.meta.terminalId,
    status,
  }
  if (record.meta.exitCode !== undefined) event.exitCode = record.meta.exitCode
  if (errorMessage) event.errorMessage = errorMessage
  record.channel.emitter.next(event as { type: 'terminal.state' })
}

/**
 * 状态迁移：去重（同值不重发）+ 终态吸收（closed/exited/failed/disconnected 之后
 * 通知驱动的迁移一律忽略，含 exited-after-closed）。force 用于命令路径的收敛迁移。
 * 返回是否真正发生了迁移（用于调用方判断）。
 */
export function transitionStatus(
  record: TerminalRecord,
  next: TerminalStatus,
  extra?: StatusExtra,
): boolean {
  const current = record.meta.status
  if (current === next) return false
  if (TERMINAL.has(current) && !extra?.force) return false
  record.meta.status = next
  if (extra?.exitCode !== undefined) record.meta.exitCode = extra.exitCode
  emitState(record, next, extra?.errorMessage)
  return true
}
