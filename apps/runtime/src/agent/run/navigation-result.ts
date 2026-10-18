import { AgentBrowserNavigateSchema } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'

/** Read only canonical persisted results; never create a page or retry navigation. */
export function navigationResult(
  store: Store,
  toolCallId: string,
  status: string,
) {
  if (status !== 'failed' && status !== 'completed') return {}
  const call = store.toolCalls.get(toolCallId)
  if (call?.toolName !== 'browser.navigate' || !call.output) return {}
  const input = AgentBrowserNavigateSchema.safeParse(call.args)
  const run = store.runs.get(call.runId)
  if (!input.success || !run) return {}
  let root = run
  const visited = new Set([run.id])
  while (root.parentRunId && !visited.has(root.parentRunId)) {
    const parent = store.runs.get(root.parentRunId)
    if (!parent) break
    visited.add(parent.id)
    root = parent
  }
  return {
    navigation: {
      sessionId: run.sessionId,
      rootSessionId: root.sessionId,
      url: input.data.url,
      message: status === 'failed' ? call.output.content.slice(0, 8000) : '',
    },
  }
}
