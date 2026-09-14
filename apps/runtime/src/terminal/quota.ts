import { CommandError } from '../agent/errors.js'
import type { RecordIndex, TerminalServiceConfig } from './records.js'

/**
 * 配额裁决与 closed 记录 TTL 清扫（终审 #1，spec §5/§6 额度表）：只依赖
 * RecordIndex 与配置的纯编排单元，从 TerminalService 拆出以维持单职责
 * （AGENTS §4 500 行硬上限在本轮变更中就地触发）。
 */

export function enforceQuota(
  index: RecordIndex,
  config: TerminalServiceConfig,
  projectId: string,
): void {
  const { projectActive, globalActive, retained } = index.quotaCounts(projectId)
  if (projectActive >= config.maxActivePerProject) {
    throw new CommandError(
      'terminal_quota_project',
      `项目活动终端数已达上限 ${config.maxActivePerProject}`,
    )
  }
  if (globalActive >= config.maxActiveGlobal) {
    throw new CommandError(
      'terminal_quota_global',
      `全局活动终端数已达上限 ${config.maxActiveGlobal}`,
    )
  }
  if (retained >= config.maxRetained) {
    throw new CommandError(
      'terminal_quota_retained',
      `留存终端数已达上限 ${config.maxRetained}，请清理已退出终端`,
    )
  }
}

/**
 * closed 记录 TTL 清扫（spec §5「closed 标签不长期保留」）：closed 不占
 * 留存额度后，唯一离索引时机就是这里——否则 records/emitter 单调增长。
 * 钩点选在 create 的额度检查之前：额度与内存压力只在 create 显现，读路径
 * （list）不背清扫义务、也不给查询引入时序不确定性；shutdown 整表弃置，
 * 无需扫。remove 一并 evict emitter（RecordIndex.remove 既有职责）。
 */
export function sweepClosedRecords(
  index: RecordIndex,
  config: TerminalServiceConfig,
  now: number,
): void {
  const cutoff = now - config.closedRetentionMs
  for (const [terminalId, record] of index.records) {
    if (
      record.meta.status === 'closed' &&
      record.closedAtMs !== undefined &&
      record.closedAtMs <= cutoff
    ) {
      index.remove(terminalId)
    }
  }
}
