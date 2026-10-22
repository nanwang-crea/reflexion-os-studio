import type { DatabaseSync } from 'node:sqlite'
import {
  DeveloperOverviewSchema,
  type DeveloperFilter,
  type DeveloperOverview,
} from '@reflexion-os-studio/contracts'
import { filterSql, USAGE_AGGREGATES, VALID_USAGE } from './query.js'

export class DeveloperOverviewQueries {
  constructor(private readonly db: DatabaseSync) {}

  get(filter: DeveloperFilter): DeveloperOverview {
    const runs = filterSql(filter)
    const aux = filterSql(filter, 'i')
    // Run totals already include chat invocations. Only auxiliary calls are added.
    const sources = `WITH sources AS (
      SELECT r.model AS model, r.provider_id AS provider, r.started_at AS time,
        ${VALID_USAGE('r.usage_json')} AS usage,
        (SELECT COUNT(*) FROM model_invocations i WHERE i.run_id = r.id AND i.purpose = 'chat' AND i.usage_json IS NULL) AS unreported,
        NOT EXISTS(SELECT 1 FROM model_invocations i WHERE i.run_id = r.id AND i.purpose = 'chat') AS legacy
      FROM runs r JOIN sessions s ON s.id = r.session_id WHERE ${runs.where}
      UNION ALL
      SELECT i.model, i.provider_id, i.started_at, ${VALID_USAGE('i.usage_json')},
        i.usage_json IS NULL, 0
      FROM model_invocations i JOIN sessions s ON s.id = i.session_id
      WHERE i.purpose != 'chat' AND ${aux.where}
    )`
    const values = [...runs.values, ...aux.values]
    const usage = this.db
      .prepare(`${sources} SELECT ${USAGE_AGGREGATES} FROM sources`)
      .get(...values)
    const days = this.db
      .prepare(
        `${sources} SELECT substr(time, 1, 10) AS key, ${USAGE_AGGREGATES}
      FROM sources GROUP BY key ORDER BY key`,
      )
      .all(...values)
    const models = this.db
      .prepare(
        `${sources} SELECT COALESCE(provider, '未知 Provider') || ' / ' || COALESCE(model, '未知模型') AS key,
        COALESCE((SELECT name FROM provider_profiles WHERE id = provider), provider, '未知 Provider') || ' / ' || COALESCE(model, '未知模型') AS label,
      ${USAGE_AGGREGATES} FROM sources GROUP BY provider, model ORDER BY promptTokens + completionTokens DESC`,
      )
      .all(...values)
    const runCounts = this.db
      .prepare(
        `SELECT COUNT(*) AS runs,
      COALESCE(SUM(r.status = 'failed'), 0) AS failedRuns
      FROM runs r JOIN sessions s ON s.id = r.session_id WHERE ${runs.where}`,
      )
      .get(...runs.values)
    const toolFilter = filterSql(filter, 'r', 'tc.created_at')
    const toolFrom = `FROM tool_calls tc JOIN runs r ON r.id = tc.run_id JOIN sessions s ON s.id = r.session_id WHERE ${toolFilter.where}`
    const tools = this.db
      .prepare(
        `SELECT COUNT(*) AS tools, COALESCE(SUM(tc.status = 'failed'), 0) AS failedTools ${toolFrom}`,
      )
      .get(...toolFilter.values)
    const toolGroups = this.db
      .prepare(
        `SELECT tc.tool_name AS name, COUNT(*) AS calls,
      COALESCE(SUM(tc.status = 'failed'), 0) AS failures ${toolFrom}
      GROUP BY tc.tool_name ORDER BY calls DESC, name`,
      )
      .all(...toolFilter.values)
    return DeveloperOverviewSchema.parse({
      usage,
      days,
      models,
      ...runCounts,
      ...tools,
      toolGroups,
    })
  }
}
