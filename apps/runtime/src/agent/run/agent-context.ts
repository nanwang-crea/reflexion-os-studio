import type { AgentContextView, Run } from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'

/** 从 canonical Run/Delegation 数据投影统一的 Agent 来源标签。 */
export function agentContextForRun(
  store: Store,
  run: Run,
  explicitRootRunId?: string,
): AgentContextView {
  const delegation =
    run.delegationId === null ? null : store.delegations.get(run.delegationId)
  const rootRunId =
    explicitRootRunId ?? delegation?.rootRunId ?? run.parentRunId ?? run.id
  const rootRun = store.runs.get(rootRunId)
  const rootTask = rootRun
    ? store.messages
        .listBySession(rootRun.sessionId)
        .find(
          (message) => message.runId === rootRunId && message.role === 'user',
        )?.content
    : undefined
  return {
    instanceId: run.agentId,
    displayName: delegation?.agentInstance?.name ?? 'Primary Agent',
    depth: delegation?.execution?.depth ?? 0,
    rootRunId,
    rootTask: (rootTask?.trim() || '当前任务').slice(0, 160),
  }
}
