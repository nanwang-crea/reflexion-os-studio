import type {
  WorkflowAgentNode,
  WorkflowAttempt,
} from '@reflexion-os-studio/contracts'
import { ChildLimitError } from '../../agent/errors.js'
import { publishNodeResult, settleAttempt } from './lifecycle.js'
import type { WorkflowServiceDeps } from './deps.js'
import type { WorkflowExecutionContext } from './context.js'

const EFFECT_FREE = new Set([
  'get_current_time',
  'skill.use',
  'file.read',
  'file.list',
  'file.glob',
  'file.grep',
  'shell.output.read',
])

export async function executeWorkflowNode(
  deps: WorkflowServiceDeps,
  changed: (projectId: string, id: string) => void,
  fail: (code: string) => void,
  projectId: string,
  id: string,
  context: WorkflowExecutionContext,
  attempt: WorkflowAttempt,
  node: WorkflowAgentNode,
  inputs: Parameters<WorkflowServiceDeps['validateResources']>[1],
): Promise<void> {
  const { store } = deps
  try {
    const root = store.workflowRuns.get(id)!
    const model = root.snapshot.models.find((item) => item.nodeId === node.id)!
    const result = await deps.executor.execute({
      workflowRunId: id,
      attemptId: attempt.id,
      projectId,
      node: {
        ...node,
        budget: { ...node.budget, maxTokens: attempt.tokenBudget },
      },
      inputs,
      providerId: model.providerId,
      model: model.model,
      profile: model.profile,
      permissionPreset: root.snapshot.permissionPreset,
      approvalOverride: root.snapshot.approvalOverride,
      permissionDomainId: context.permissionDomainId,
      mutationCoordinator: context.mutations,
      signal: context.controller.signal,
      onBeforeModel: () => {
        if (context.controller.signal.aborted)
          throw new DOMException('Aborted', 'AbortError')
        const current = store.workflowAttempts.get(attempt.id)!
        store.workflowAttempts.update({ ...current, modelPending: true })
      },
      onToolBatch: (names) => {
        const run = store.workflowRuns.get(id)!
        if (context.controller.signal.aborted || run.status !== 'running')
          throw new DOMException('Aborted', 'AbortError')
        if (
          run.toolsUsed + names.length >
          run.snapshot.definition.budget.maxToolCalls
        )
          throw new ChildLimitError(
            'workflow_tool_budget',
            'Workflow tool budget exhausted',
          )
        store.workflowRuns.update({
          ...run,
          toolsUsed: run.toolsUsed + names.length,
        })
      },
      beforeToolInvoke: (name) => {
        if (context.controller.signal.aborted)
          throw new DOMException('Aborted', 'AbortError')
        if (!EFFECT_FREE.has(name))
          store.workflowAttempts.markPossibleEffect(attempt.id)
      },
      onModelResult: (usage, estimated) => {
        const run = store.workflowRuns.get(id)!
        const tokensUsed =
          run.tokensUsed + usage.promptTokens + usage.completionTokens
        store.transaction(() => {
          const current = store.workflowAttempts.get(attempt.id)!
          store.workflowAttempts.update({ ...current, modelPending: false })
          store.workflowRuns.update({
            ...run,
            tokensUsed,
            tokensEstimated: run.tokensEstimated || estimated === true,
          })
        })
        if (tokensUsed > run.snapshot.definition.budget.maxTokens)
          throw new ChildLimitError(
            'workflow_token_budget',
            'Workflow token budget exhausted',
          )
      },
    })
    if (context.controller.signal.aborted)
      throw new DOMException('Aborted', 'AbortError')
    await deps.validateResources(
      projectId,
      result.outputs,
      context.controller.signal,
    )
    if (context.controller.signal.aborted)
      throw new DOMException('Aborted', 'AbortError')
    publishNodeResult(store, attempt.id, result.outputs)
    changed(projectId, id)
  } catch (error) {
    const aborted = context.controller.signal.aborted
    const code =
      error instanceof ChildLimitError
        ? error.code
        : error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
          ? error.message
          : 'workflow_node_failed'
    const pending = store.workflowAttempts.get(attempt.id)
    if (pending?.modelPending) {
      const run = store.workflowRuns.get(id)!
      store.transaction(() => {
        store.workflowAttempts.update({ ...pending, modelPending: false })
        store.workflowRuns.update({
          ...run,
          tokensUsed: run.tokensUsed + pending.tokenBudget,
          tokensEstimated: true,
        })
      })
    }
    settleAttempt(store, attempt.id, aborted ? 'cancelled' : 'failed', code)
    if (!aborted) fail(code)
  }
}
