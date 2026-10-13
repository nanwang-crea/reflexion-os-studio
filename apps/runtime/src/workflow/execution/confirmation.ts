import type { WorkflowService } from '../service.js'
import { workflowHash } from './resources.js'

export async function respondToWorkflowConfirmation(
  service: WorkflowService,
  input: {
    requestId?: string
    projectId: string
    runId: string
    confirmationId: string
    token: string
    inputHash: string
    approved: boolean
  },
): Promise<ReturnType<WorkflowService['get']>> {
  const { store } = service.deps
  const hash = workflowHash(input)
  if (input.requestId) {
    const replay = store.workflowRuns.requestResult(
      input.requestId,
      'workflow.confirm.respond',
      hash,
    ) as { detail: ReturnType<WorkflowService['get']> } | null
    if (replay) return replay.detail
  }
  const detail = service.get(input.projectId, input.runId)
  const item = store.workflowConfirmations.get(input.confirmationId)
  const context = service.context(input.runId)
  if (
    !item ||
    item.workflowRunId !== input.runId ||
    item.status !== 'pending' ||
    !context ||
    !['running', 'waiting_user'].includes(detail.run.status) ||
    item.token !== input.token ||
    item.inputHash !== input.inputHash ||
    workflowHash(item.inputs) !== item.inputHash
  )
    throw new Error('workflow_confirmation_invalid')
  if (Date.parse(item.expiresAt) <= Date.now()) {
    store.workflowConfirmations.resolve(item.id, 'expired')
    service.scheduler.fail(
      input.runId,
      context,
      'workflow_confirmation_expired',
    )
    service.scheduler.drive(input.projectId, input.runId, context)
    throw new Error('workflow_confirmation_expired')
  }
  await service.deps.validateResources(
    input.projectId,
    item.inputs,
    context.controller.signal,
  )
  if (input.requestId) {
    const raced = store.workflowRuns.requestResult(
      input.requestId,
      'workflow.confirm.respond',
      hash,
    ) as { detail: ReturnType<WorkflowService['get']> } | null
    if (raced) return raced.detail
  }
  if (
    context.controller.signal.aborted ||
    store.workflowConfirmations.get(item.id)?.status !== 'pending'
  )
    throw new Error('workflow_confirmation_invalid')
  store.transaction(() => {
    store.workflowConfirmations.resolve(
      item.id,
      input.approved ? 'approved' : 'rejected',
    )
    const run = store.workflowRuns.get(input.runId)!
    const attempt = store.workflowAttempts.get(item.attemptId)!
    if (!input.approved) {
      store.workflowAttempts.update({
        ...attempt,
        status: 'rejected',
        errorCode: 'workflow_rejected',
        completedAt: new Date().toISOString(),
      })
      store.workflowRuns.update({
        ...run,
        status: 'cancelling',
        errorCode: 'workflow_rejected',
      })
    } else {
      const node = run.snapshot.definition.nodes.find(
        (node) => node.id === item.nodeId,
      )!
      const values = Object.fromEntries(
        node.outputs.flatMap((port) =>
          Object.hasOwn(item.inputs, port.key)
            ? [[port.key, item.inputs[port.key]]]
            : [],
        ),
      )
      store.workflowAttempts.update({
        ...attempt,
        status: 'succeeded',
        completedAt: new Date().toISOString(),
      })
      store.workflowOutputs.publish({
        attemptId: attempt.id,
        workflowRunId: run.id,
        nodeId: node.id,
        values,
        hash: workflowHash(values),
        createdAt: new Date().toISOString(),
      })
      store.workflowRuns.update({ ...run, status: 'running' })
    }
    if (input.requestId)
      store.workflowRuns.recordRequest(
        input.projectId,
        input.requestId,
        'workflow.confirm.respond',
        hash,
        { detail: service.get(input.projectId, input.runId) },
      )
  })
  if (!input.approved) {
    context.failure = 'workflow_rejected'
    context.controller.abort()
  }
  service.scheduler.armConfirmationTimer(input.projectId, input.runId, context)
  service.scheduler.drive(input.projectId, input.runId, context)
  service.changed(input.projectId, input.runId)
  return service.get(input.projectId, input.runId)
}
