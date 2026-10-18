import type { Delegation } from '@reflexion-os-studio/contracts'
import type { ToolContext } from '../shared.js'

/** Scope comes from canonical runs; caller arguments can never widen it. */
export function visibleDelegations(ctx: ToolContext): Delegation[] {
  const run = ctx.store.runs.get(ctx.runId)
  if (!run || run.sessionId !== ctx.sessionId)
    throw new Error('当前 Run 与会话不匹配')
  const session = ctx.store.sessions.get(ctx.sessionId)
  if (!session || session.projectId !== ctx.projectId)
    throw new Error('当前项目与会话不匹配')
  let root = run
  const seen = new Set<string>()
  while (root.parentRunId !== null) {
    if (seen.has(root.id)) throw new Error('委派树关系无效')
    seen.add(root.id)
    const parent = ctx.store.runs.get(root.parentRunId)
    if (!parent) throw new Error('委派树父 Run 不存在')
    root = parent
  }
  // Later root runs retain access to earlier trees belonging to this exact session.
  const direct = ctx.store.delegations.listBySession(root.sessionId)
  const trees = new Map(direct.map((item) => [item.id, item]))
  for (const root of new Set(
    direct.map((item) => item.rootRunId ?? item.parentRunId),
  )) {
    for (const item of ctx.store.delegations.listByRootRun(root))
      trees.set(item.id, item)
  }
  return [...trees.values()]
}

export function requireChildSession(
  ctx: ToolContext,
  delegation: Delegation,
): string | null {
  if (!delegation.childSessionId) return null
  const child = delegation.childRunId
    ? ctx.store.runs.get(delegation.childRunId)
    : null
  if (
    !child ||
    child.sessionId !== delegation.childSessionId ||
    child.parentRunId === null ||
    child.delegationId !== delegation.id
  )
    throw new Error('委派子 Run 关系无效')
  const session = ctx.store.sessions.get(delegation.childSessionId)
  if (!session || session.projectId !== ctx.projectId)
    throw new Error('委派子会话不可访问')
  return session.id
}
