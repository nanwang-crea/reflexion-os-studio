import type { DatabaseSync } from 'node:sqlite'
import {
  AgentUnlimitedLimitSchema,
  type AgentSettings,
} from '@reflexion-os-studio/contracts'

/** 全量默认(与内置常量一致):null 即"未配置"。 */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxTurns: null,
  reflectionThreshold: null,
  requestRetries: null,
  requestTimeoutSec: null,
  requestBackoffInitialSec: null,
  requestBackoffMaxSec: null,
  maxRunTimeoutSec: null,
  maxRunTotalTokens: null,
  maxToolCalls: null,
  maxContinuationTurns: null,
  maxDepth: 1,
  maxChildRuns: 4,
  maxParallelChildren: 2,
  maxChildTimeoutSec: null,
  maxChildTotalTokens: 12000,
  enableChildRuns: true,
}

/**
 * Agent 运行时全局设置(单行 JSON 表):仅存覆盖值,null 回退内置默认。
 * 领域门面同 Store 其它对象一致,业务代码不直接写 SQL。
 *
 * Phase 3A 默认启用一层只读委派；显式保存 false 仍可作为运行时逃生开关。
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
      const unlimited = AgentUnlimitedLimitSchema.array()
        .max(8)
        .safeParse(parsed.unlimitedLimits)
      return {
        ...(unlimited.success
          ? { unlimitedLimits: [...new Set(unlimited.data)] }
          : {}),
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
        requestBackoffInitialSec:
          typeof parsed.requestBackoffInitialSec === 'number'
            ? parsed.requestBackoffInitialSec
            : null,
        requestBackoffMaxSec:
          typeof parsed.requestBackoffMaxSec === 'number'
            ? parsed.requestBackoffMaxSec
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
        // 数量与深度缺失时回退保守默认；子任务超时默认不单独限制。
        maxDepth:
          typeof parsed.maxDepth === 'number'
            ? parsed.maxDepth
            : DEFAULT_AGENT_SETTINGS.maxDepth,
        maxChildRuns:
          parsed.maxChildRuns === null ||
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
          parsed.maxChildTotalTokens === null ||
          typeof parsed.maxChildTotalTokens === 'number'
            ? parsed.maxChildTotalTokens
            : DEFAULT_AGENT_SETTINGS.maxChildTotalTokens,
        enableChildRuns:
          typeof parsed.enableChildRuns === 'boolean'
            ? parsed.enableChildRuns
            : DEFAULT_AGENT_SETTINGS.enableChildRuns,
      }
    } catch {
      return { ...DEFAULT_AGENT_SETTINGS }
    }
  }
}
