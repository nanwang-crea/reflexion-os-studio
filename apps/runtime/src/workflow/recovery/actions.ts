import { validatePortValues } from '../graph/ports.js'
import { nodeInputs } from '../graph/dataflow.js'
import { validateWorkflow } from '../graph/validate.js'
import type { WorkflowService } from '../service.js'
import { workflowHash } from '../execution/resources.js'
import { publishNodeResult } from '../execution/lifecycle.js'
import { preflightWorkflow } from '../execution/preflight.js'

export async function resumeWorkflow(
  service: WorkflowService,
  input: {
    requestId?: string
    projectId: string
    runId: string
    stateVersion: number
    acknowledgedAttemptIds: string[]
    nodeId?: string
  },
): Promise<ReturnType<WorkflowService['get']>> {
  const { store } = service.deps
  const method = input.nodeId
    ? 'workflow.run.retry_node'
    : 'workflow.run.resume'
  const hash = workflowHash(input)
  if (input.requestId) {
    const replay = store.workflowRuns.requestResult(
      input.requestId,
      method,
      hash,
    ) as { detail: ReturnType<WorkflowService['get']> } | null
    if (replay) return replay.detail
  }
  const detail = service.get(input.projectId, input.runId)
  if (
    !['failed', 'interrupted'].includes(detail.run.status) ||
    service.context(input.runId) ||
    detail.run.stateVersion !== input.stateVersion
  )
    throw new Error('workflow_state_conflict')
  if (detail.attempts.some((attempt) => attempt.status === 'rejected'))
    throw new Error('workflow_rejected')
  if (
    input.nodeId &&
    (detail.outputs.some((item) => item.nodeId === input.nodeId) ||
      !detail.attempts.some((item) => item.nodeId === input.nodeId))
  )
    throw new Error('workflow_retry_invalid')
  const defaultModel = detail.run.snapshot.models[0]
  if (!defaultModel) throw new Error('workflow_configuration_unavailable')
  const preflight = preflightWorkflow(detail.run.snapshot.definition, {
    defaultModel,
    providers: store.providers.list(),
    availableTools: service.deps.availableTools(input.projectId),
  })
  // Resolve each frozen binding, not a possibly changed global default.
  if (
    detail.run.snapshot.models.some((model) => {
      const provider = store.providers.get(model.providerId)
      return (
        !provider?.enabled ||
        !provider.capabilities.includes('chat') ||
        !provider.models.includes(model.model)
      )
    }) ||
    preflight.issues.some((issue) => issue.code === 'tool_unavailable')
  )
    throw new Error('workflow_configuration_unavailable')
  await service.deps.validateResources(
    input.projectId,
    detail.run.snapshot.inputs,
  )
  for (const output of detail.outputs) {
    const node = detail.run.snapshot.definition.nodes.find(
      (node) => node.id === output.nodeId,
    )
    const attempt = detail.attempts.find(
      (attempt) => attempt.id === output.attemptId,
    )
    if (
      !node ||
      !attempt ||
      attempt.nodeId !== output.nodeId ||
      attempt.status !== 'succeeded' ||
      validatePortValues(node.outputs, output.values).length ||
      workflowHash(output.values) !== output.hash
    )
      throw new Error('workflow_output_corrupt')
    await service.deps.validateResources(input.projectId, output.values)
  }
  const recoverable: {
    attemptId: string
    values: import('@reflexion-os-studio/contracts').WorkflowValues
  }[] = []
  const provisional = { ...detail, outputs: [...detail.outputs] }
  for (const nodeId of validateWorkflow(detail.run.snapshot.definition).order) {
    if (provisional.outputs.some((item) => item.nodeId === nodeId)) continue
    const attempt = detail.attempts
      .filter((item) => item.nodeId === nodeId)
      .at(-1)
    if (!attempt) continue
    const stage = store.workflowAttempts.result(attempt.id)
    const completed =
      attempt.agentRunId &&
      store.runs.get(attempt.agentRunId)?.status === 'completed'
    const node = detail.run.snapshot.definition.nodes.find(
      (item) => item.id === nodeId,
    )!
    if (attempt.status === 'interrupted' && completed && stage?.values) {
      if (
        validatePortValues(node.outputs, stage.values).length ||
        workflowHash(nodeInputs(provisional, node)) !== attempt.inputHash
      )
        throw new Error('workflow_checkpoint_corrupt')
      await service.deps.validateResources(input.projectId, stage.values)
      recoverable.push({ attemptId: attempt.id, values: stage.values })
      provisional.outputs.push({
        attemptId: attempt.id,
        workflowRunId: detail.run.id,
        nodeId,
        values: stage.values,
        hash: workflowHash(stage.values),
        createdAt: new Date().toISOString(),
      })
    } else if (
      attempt.effectStatus !== 'none' &&
      !input.acknowledgedAttemptIds.includes(attempt.id)
    ) {
      throw new Error('workflow_effect_review_required')
    }
  }
  if (input.requestId) {
    const raced = store.workflowRuns.requestResult(
      input.requestId,
      method,
      hash,
    ) as { detail: ReturnType<WorkflowService['get']> } | null
    if (raced) return raced.detail
  }
  const current = store.workflowRuns.get(input.runId)!
  if (current.stateVersion !== input.stateVersion)
    throw new Error('workflow_state_conflict')
  if (
    current.tokensUsed >= current.snapshot.definition.budget.maxTokens ||
    current.executionMs >=
      current.snapshot.definition.budget.maxExecutionSec * 1000
  )
    throw new Error('workflow_budget_exhausted')
  store.transaction(() => {
    store.workflowRuns.update({
      ...current,
      status: 'running',
      errorCode: null,
    })
    for (const item of recoverable)
      publishNodeResultWithinResume(service, item.attemptId, item.values)
    if (input.requestId)
      store.workflowRuns.recordRequest(
        input.projectId,
        input.requestId,
        method,
        hash,
        {
          detail: service.get(input.projectId, input.runId),
        },
      )
  })
  service.activate(input.projectId, input.runId)
  service.changed(input.projectId, input.runId)
  return service.get(input.projectId, input.runId)
}

// publishNodeResult owns a transaction; do not nest it inside the state transition transaction.
function publishNodeResultWithinResume(
  service: WorkflowService,
  attemptId: string,
  values: Parameters<typeof publishNodeResult>[2],
): void {
  const { store } = service.deps
  const attempt = store.workflowAttempts.get(attemptId)!
  store.workflowAttempts.restoreCompleted({
    ...attempt,
    status: 'succeeded',
    modelPending: false,
    completedAt: new Date().toISOString(),
  })
  store.workflowOutputs.publish({
    attemptId,
    workflowRunId: attempt.workflowRunId,
    nodeId: attempt.nodeId,
    values,
    hash: workflowHash(values),
    createdAt: new Date().toISOString(),
  })
}
