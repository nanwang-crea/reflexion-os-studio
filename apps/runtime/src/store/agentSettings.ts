import type { DatabaseSync } from 'node:sqlite'
import type { AgentSettings } from '@reflexion-os-studio/contracts'

/** 全量默认(与内置常量一致):null 即"未配置"。 */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxTurns: null,
  reflectionThreshold: null,
  requestRetries: null,
  requestTimeoutSec: null,
}

/**
 * Agent 运行时全局设置(单行 JSON 表):仅存覆盖值,null 回退内置默认。
 * 领域门面同 Store 其它对象一致,业务代码不直接写 SQL。
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
      }
    } catch {
      return { ...DEFAULT_AGENT_SETTINGS }
    }
  }
}
