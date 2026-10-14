import type { ToolContext } from '../shared.js'

export function requirePrimaryTeamAccess(ctx: ToolContext): void {
  const run = ctx.store.runs.get(ctx.runId)
  if (!run || run.parentRunId !== null)
    throw new Error('团队配置仅允许主 Agent 管理')
}
