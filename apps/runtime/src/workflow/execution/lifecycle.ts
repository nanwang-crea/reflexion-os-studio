import { assertWorkflowValuesSafe } from '../security/content.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { WorkflowValuesSchema } from '@reflexion-os-studio/contracts'
import type {
  WorkflowNode,
  WorkflowRunDetail,
  WorkflowValues,
  WorkflowAttempt,
} from '@reflexion-os-studio/contracts'
import type { Store } from '../../store/index.js'
import { workflowHash } from './resources.js'
import { validatePortValues } from '../graph/ports.js'

export function workflowDetail(
  store: Store,
  projectId: string,
  id: string,
): WorkflowRunDetail {
  const run = store.workflowRuns.get(id)
  if (!run || run.projectId !== projectId) throw new Error('workflow_not_found')
  return {
    run,
    attempts: store.workflowAttempts.list(id),
    outputs: store.workflowOutputs.list(id),
    confirmations: store.workflowConfirmations.list(id),
    changedFiles: store.workflowAttempts.list(id).flatMap((attempt) => {
      if (!attempt.agentRunId) return []
      const files = store.toolCalls
        .listByRun(attempt.agentRunId)
        .flatMap((call) =>
          call.status === 'completed' ? (call.output?.changedFiles ?? []) : [],
        )
      return files.length
        ? [
            {
              nodeId: attempt.nodeId,
              attemptId: attempt.id,
              runId: attempt.agentRunId,
              files,
            },
          ]
        : []
    }),
    result:
      run.status === 'succeeded'
        ? workflowFinalValues(
            run.snapshot.definition,
            store.workflowOutputs.list(id),
          )
        : null,
  }
}
export function createNodeAttempt(
  store: Store,
  detail: WorkflowRunDetail,
  node: WorkflowNode,
  inputs: WorkflowValues,
  tokenBudget: number,
): WorkflowAttempt {
  return store.transaction(() => {
    const run = store.workflowRuns.get(detail.run.id)!
    if (run.status !== 'running') throw new Error('workflow_not_running')
    if (run.attemptsUsed >= run.snapshot.definition.budget.maxAttempts)
      throw new Error('workflow_attempt_budget')
    const attemptNo =
      Math.max(
        0,
        ...store.workflowAttempts
          .list(run.id)
          .filter((attempt) => attempt.nodeId === node.id)
          .map((attempt) => attempt.attemptNo),
      ) + 1
    const attempt = store.workflowAttempts.create({
      id: randomUUID(),
      workflowRunId: run.id,
      nodeId: node.id,
      attemptNo,
      status: node.kind === 'confirmation' ? 'waiting_user' : 'running',
      agentRunId: null,
      sessionId: null,
      inputHash: workflowHash(inputs),
      tokenBudget,
      modelPending: false,
      effectStatus: 'none',
      errorCode: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    })
    store.workflowRuns.update({ ...run, attemptsUsed: run.attemptsUsed + 1 })
    if (node.kind === 'confirmation')
      store.workflowConfirmations.create({
        id: randomUUID(),
        workflowRunId: run.id,
        attemptId: attempt.id,
        nodeId: node.id,
        inputs,
        inputHash: attempt.inputHash,
        token: randomBytes(32).toString('hex'),
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(
          Date.now() +
            run.snapshot.definition.budget.confirmationExpirySec * 1000,
        ).toISOString(),
      })
    return attempt
  })
}
export function publishNodeResult(
  store: Store,
  attemptId: string,
  values: WorkflowValues,
  recovery = false,
): void {
  store.transaction(() => {
    const attempt = store.workflowAttempts.get(attemptId)!
    const run = store.workflowRuns.get(attempt.workflowRunId)!
    if (
      run.status !== 'running' ||
      (!recovery && !['running', 'waiting_user'].includes(attempt.status))
    )
      throw new Error('workflow_late_result')
    assertWorkflowValuesSafe(values)
    const node = run.snapshot.definition.nodes.find(
      (node) => node.id === attempt.nodeId,
    )!
    if (validatePortValues(node.outputs, values).length)
      throw new Error('output_validation_failed')
    const completed = {
      ...attempt,
      status: 'succeeded' as const,
      completedAt: new Date().toISOString(),
    }
    if (recovery) store.workflowAttempts.restoreCompleted(completed)
    else store.workflowAttempts.update(completed)
    store.workflowOutputs.publish({
      attemptId,
      workflowRunId: run.id,
      nodeId: attempt.nodeId,
      values,
      hash: workflowHash(values),
      createdAt: new Date().toISOString(),
    })
    store.workflowRuns.update(run)
  })
}
export function settleAttempt(
  store: Store,
  id: string,
  status: 'failed' | 'cancelled' | 'interrupted',
  errorCode: string,
): void {
  const attempt = store.workflowAttempts.get(id)
  if (
    attempt &&
    ['pending', 'running', 'waiting_user'].includes(attempt.status)
  )
    store.workflowAttempts.update({
      ...attempt,
      status,
      errorCode,
      completedAt: new Date().toISOString(),
    })
}

export function workflowFinalValues(
  definition: import('@reflexion-os-studio/contracts').WorkflowDefinition,
  outputs: import('@reflexion-os-studio/contracts').WorkflowPublishedOutput[],
): WorkflowValues {
  const values: WorkflowValues = Object.create(null)
  for (const binding of definition.outputs) {
    const output = outputs.find((item) => item.nodeId === binding.from.nodeId)
    const value =
      output && Object.hasOwn(output.values, binding.from.portKey)
        ? output.values[binding.from.portKey]
        : undefined
    if (value !== undefined) values[binding.port.key] = value
  }
  const parsed = WorkflowValuesSchema.parse(values)
  if (
    validatePortValues(
      definition.outputs.map((binding) => binding.port),
      parsed,
    ).length
  )
    throw new Error('workflow_result_invalid')
  return parsed
}
