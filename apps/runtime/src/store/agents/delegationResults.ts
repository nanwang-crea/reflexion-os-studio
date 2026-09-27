import type { DatabaseSync } from 'node:sqlite'
import type {
  DelegationResult,
  JsonValue,
  Usage,
} from '@reflexion-os-studio/contracts'
import { coerceToolOutput, UsageSchema } from '@reflexion-os-studio/contracts'

/** Aggregate canonical tool outputs produced by one child run. */
export function buildDelegationResult(
  db: DatabaseSync,
  childRunId: string,
  summary: string,
): DelegationResult {
  const rows = db
    .prepare(
      `SELECT result_json FROM tool_calls
       WHERE run_id = ? ORDER BY created_at, rowid`,
    )
    .all(childRunId) as { result_json: string | null }[]
  const links = new Map<string, DelegationResult['resourceLinks'][number]>()
  const files = new Map<string, DelegationResult['changedFiles'][number]>()
  for (const row of rows) {
    if (row.result_json === null) continue
    let value: JsonValue
    try {
      value = JSON.parse(row.result_json) as JsonValue
    } catch {
      continue
    }
    const output = coerceToolOutput(value)
    for (const link of output.resourceLinks) links.set(link.uri, link)
    for (const file of output.changedFiles) {
      files.set(`${file.action}:${file.oldPath ?? ''}:${file.path}`, file)
    }
  }
  const run = db
    .prepare('SELECT usage_json FROM runs WHERE id = ?')
    .get(childRunId) as { usage_json: string | null } | undefined
  let usage: Usage | null = null
  if (run?.usage_json) {
    try {
      const parsed = UsageSchema.safeParse(JSON.parse(run.usage_json))
      usage = parsed.success ? parsed.data : null
    } catch {
      usage = null
    }
  }
  return {
    version: 1,
    summary,
    resourceLinks: [...links.values()],
    changedFiles: [...files.values()],
    usage,
    toolCallCount: rows.length,
  }
}
