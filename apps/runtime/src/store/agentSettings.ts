import type { DatabaseSync } from 'node:sqlite'
import type { AgentSettings } from '@reflexion-os-studio/contracts'

/** 全量默认(与内置常量一致):null 即"未配置"。 */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxTurns: null,
  reflectionThreshold: null,
  requestRetries: null,
  requestTimeoutSec: null,
  maxRunTimeoutSec: null,
  maxRunTotalTokens: null,
  maxToolCalls: null,
  maxContinuationTurns: null,
  maxDepth: 1,
  maxChildRuns: 4,
  maxParallelChildren: 2,
  maxChildTimeoutSec: 120,
  maxChildTotalTokens: 12000,
  enableChildRuns: false,
}

/**
 * Agent 运行时全局设置(单行 JSON 表):仅存覆盖值,null 回退内置默认。
 * 领域门面同 Store 其它对象一致,业务代码不直接写 SQL。
 *
 * Phase 3 边界：enableChildRuns 在读取与默认值处均强制 false（见 parse），
 * 设置保存通道也不再暴露该开关。
 */
export class AgentSettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  get(): AgentSettings {
    const row = this.db
      .prepare('SELECT settings_json FROM agent_settings WHERE id = 1')
      .get() as { settings_json: string } | undefined
    return row === undefined
      ? { ...DEFAULT_AGENT_SETTINGS }
      : this.parse(row.settings_json)
  }

  upsert(settings: AgentSettings): AgentSettings {
    this.db
      .prepare(
        `INSERT INTO agent_settings (id, settings_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           settings_json = excluded.settings_json,
           updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(settings), new Date().toISOString())
    return this.get()
  }

  private parse(raw: string): AgentSettings {
    try {
      const parsed = JSON.parse(raw) as Partial<AgentSettings>
      return {
        maxTurns: typeof parsed.maxTurns === 'number' ? parsed.maxTurns : null,
        reflectionThreshold:
          typeof parsed.reflectionThreshold === 'number'
            ? parsed.reflectionThreshold
            : null,
        requestRetries:
          typeof parsed.requestRetries === 'number'
            ? parsed.requestRetries
            : null,
        requestTimeoutSec:
          typeof parsed.requestTimeoutSec === 'number'
            ? parsed.requestTimeoutSec
            : null,
        maxRunTimeoutSec:
          typeof parsed.maxRunTimeoutSec === 'number'
            ? parsed.maxRunTimeoutSec
            : null,
        maxRunTotalTokens:
          typeof parsed.maxRunTotalTokens === 'number'
            ? parsed.maxRunTotalTokens
            : null,
        maxToolCalls:
          typeof parsed.maxToolCalls === 'number' ? parsed.maxToolCalls : null,
        maxContinuationTurns:
          typeof parsed.maxContinuationTurns === 'number'
            ? parsed.maxContinuationTurns
            : null,
        // 治理极限优先安全：旧数据/缺失时回退到内置保守默认，绝不落入"不限制"。
        maxDepth:
          typeof parsed.maxDepth === 'number'
            ? parsed.maxDepth
            : DEFAULT_AGENT_SETTINGS.maxDepth,
        maxChildRuns:
          typeof parsed.maxChildRuns === 'number'
            ? parsed.maxChildRuns
            : DEFAULT_AGENT_SETTINGS.maxChildRuns,
        maxParallelChildren:
          typeof parsed.maxParallelChildren === 'number'
            ? parsed.maxParallelChildren
            : DEFAULT_AGENT_SETTINGS.maxParallelChildren,
        maxChildTimeoutSec:
          typeof parsed.maxChildTimeoutSec === 'number'
            ? parsed.maxChildTimeoutSec
            : DEFAULT_AGENT_SETTINGS.maxChildTimeoutSec,
        maxChildTotalTokens:
          typeof parsed.maxChildTotalTokens === 'number'
            ? parsed.maxChildTotalTokens
            : DEFAULT_AGENT_SETTINGS.maxChildTotalTokens,
        // Phase 3 未启动：无论存储值如何，读取时强制关闭，
        // 保证旧 settings JSON 中 enableChildRuns=true 也不会注册 task 工具。
        enableChildRuns: false,
      }
    } catch {
      return { ...DEFAULT_AGENT_SETTINGS }
    }
  }
}
