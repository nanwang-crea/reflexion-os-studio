import type { SQLInputValue } from 'node:sqlite'
import type { DeveloperFilter } from '@reflexion-os-studio/contracts'

/** Column names are internal constants; every user value is a bound parameter. */
export function filterSql(
  filter: DeveloperFilter,
  alias = 'r',
  time = `${alias}.started_at`,
) {
  const terms: string[] = ['1 = 1']
  const values: SQLInputValue[] = []
  if (filter.projectId !== undefined) {
    terms.push(
      filter.projectId === null ? 's.project_id IS NULL' : 's.project_id = ?',
    )
    if (filter.projectId !== null) values.push(filter.projectId)
  }
  if (filter.providerId !== undefined) {
    terms.push(`${alias}.provider_id = ?`)
    values.push(filter.providerId)
  }
  if (filter.model !== undefined) {
    terms.push(`${alias}.model = ?`)
    values.push(filter.model)
  }
  if (filter.from !== undefined) {
    terms.push(`${time} >= ?`)
    values.push(new Date(filter.from).toISOString())
  }
  if (filter.to !== undefined) {
    terms.push(`${time} < ?`)
    values.push(new Date(filter.to).toISOString())
  }
  return { where: terms.join(' AND '), values }
}

export const USAGE_AGGREGATES = `
  COALESCE(SUM(json_extract(usage, '$.promptTokens')), 0) AS promptTokens,
  COALESCE(SUM(json_extract(usage, '$.completionTokens')), 0) AS completionTokens,
  COALESCE(SUM(json_extract(usage, '$.cachedPromptTokens')), 0) AS cachedPromptTokens,
  COUNT(*) AS sources,
  COUNT(usage) AS reportedSources,
  COUNT(json_extract(usage, '$.cachedPromptTokens')) AS cacheReportedSources,
  COALESCE(SUM(unreported), 0) AS unreportedCalls,
  COALESCE(SUM(legacy), 0) AS legacyRuns
`
export const VALID_USAGE = (column: string) =>
  `CASE WHEN json_valid(${column}) THEN ${column} ELSE NULL END`
