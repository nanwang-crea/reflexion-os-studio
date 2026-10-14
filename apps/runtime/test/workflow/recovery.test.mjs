import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Store } from '../../dist/store/index.js'
import { WorkflowService } from '../../dist/workflow/service.js'
import { recoverWorkflows } from '../../dist/store/workflows/execution/recovery.js'
import { workflowHash } from '../../dist/workflow/execution/resources.js'
import {
  workflowFixture,
  textPort,
} from '../../../../packages/contracts/test/fixtures/workflow.mjs'
import { harness, until } from './harness.mjs'

function confirmationFlow() {
  const flow = workflowFixture()
  flow.nodes[1] = {
    id: 'editor',
    kind: 'confirmation',
    name: 'Review',
    instruction: 'Review the draft',
    inputs: [textPort()],
    outputs: [textPort()],
  }
  return flow
}
const waiting = (h, id) =>
  until(() => {
    const detail = h.service.get(h.project.id, id)
    return detail.run.status === 'waiting_user' ? detail : null
  })
const done = (h, id) =>
  until(() => {
    const detail = h.service.get(h.project.id, id)
    return ['succeeded', 'failed', 'cancelled'].includes(detail.run.status)
      ? detail
      : null
  })

test('confirmation binds token, attempt and exact input; approval is independently idempotent', async (t) => {
  const h = harness(t, undefined, confirmationFlow())
  const detail = await waiting(h, (await h.service.start(h.start)).run.id)
  const item = detail.confirmations[0]
  const input = {
    requestId: randomUUID(),
    projectId: h.project.id,
    runId: detail.run.id,
    confirmationId: item.id,
    token: item.token,
    inputHash: item.inputHash,
    approved: true,
  }
  await assert.rejects(
    h.service.respond({ ...input, token: 'wrong'.repeat(8) }),
    /confirmation_invalid/,
  )
  await assert.rejects(
    h.service.respond({ ...input, inputHash: 'b'.repeat(64) }),
    /confirmation_invalid/,
  )
  await h.service.respond(input)
  const result = await done(h, detail.run.id)
  assert.equal(result.run.status, 'succeeded')
  assert.equal(
    result.outputs[0].values.text.value,
    result.outputs[1].values.text.value,
  )
  assert.equal(h.calls.length, 1)
  await h.service.respond(input)
  await assert.rejects(
    h.service.respond({ ...input, requestId: randomUUID() }),
    /confirmation_invalid/,
  )
})

test('human rejection cannot be retried as acceptance', async (t) => {
  const h = harness(t, undefined, confirmationFlow())
  const detail = await waiting(h, (await h.service.start(h.start)).run.id)
  const item = detail.confirmations[0]
  await h.service.respond({
    projectId: h.project.id,
    runId: detail.run.id,
    confirmationId: item.id,
    token: item.token,
    inputHash: item.inputHash,
    approved: false,
  })
  const result = await done(h, detail.run.id)
  assert.equal(result.run.status, 'failed')
  assert.equal(result.run.errorCode, 'workflow_rejected')
  await assert.rejects(
    h.service.resume({
      projectId: h.project.id,
      runId: detail.run.id,
      stateVersion: result.run.stateVersion,
      acknowledgedAttemptIds: [],
    }),
    /workflow_rejected/,
  )
})

test('reopening cancels old confirmation and explicit resume issues a fresh token', async (t) => {
  const h = harness(t, undefined, confirmationFlow())
  const detail = await waiting(h, (await h.service.start(h.start)).run.id)
  const oldContext = h.service.context(detail.run.id)
  oldContext.closed = true
  oldContext.clearTimers()
  const reopened = new Store(h.dir)
  const next = new WorkflowService({ ...h.deps, store: reopened })
  t.after(async () => {
    await next.dispose()
    reopened.close()
  })
  const interrupted = next.get(h.project.id, detail.run.id)
  assert.equal(interrupted.run.status, 'interrupted')
  assert.equal(interrupted.confirmations[0].status, 'cancelled')
  await next.resume({
    requestId: randomUUID(),
    projectId: h.project.id,
    runId: detail.run.id,
    stateVersion: interrupted.run.stateVersion,
    acknowledgedAttemptIds: [],
  })
  const resumed = await until(() => {
    const value = next.get(h.project.id, detail.run.id)
    return value.run.status === 'waiting_user' ? value : null
  })
  assert.equal(resumed.outputs.length, 1)
  assert.equal(h.calls.length, 1)
  assert.notEqual(resumed.confirmations[1].token, detail.confirmations[0].token)
})

test('unknown effects require explicit review and success outputs are reused on retry', async (t) => {
  let failed = false
  const h = harness(t, async (input) => {
    if (input.node.id === 'editor' && !failed) {
      failed = true
      input.onToolBatch(['shell.execute'])
      input.beforeToolInvoke('shell.execute')
      throw new Error('synthetic_failure')
    }
    return { text: { type: 'text', value: 'done' } }
  })
  const detail = await done(h, (await h.service.start(h.start)).run.id)
  const last = detail.attempts.at(-1)
  const input = {
    requestId: randomUUID(),
    projectId: h.project.id,
    runId: detail.run.id,
    stateVersion: detail.run.stateVersion,
    acknowledgedAttemptIds: [],
    nodeId: 'editor',
  }
  await assert.rejects(h.service.resume(input), /effect_review_required/)
  await assert.rejects(
    h.service.resume({ ...input, nodeId: 'writer' }),
    /retry_invalid/,
  )
  await h.service.resume({ ...input, acknowledgedAttemptIds: [last.id] })
  const result = await done(h, detail.run.id)
  assert.equal(result.run.status, 'succeeded')
  assert.deepEqual(
    h.calls.map((call) => call.node.id),
    ['writer', 'editor', 'editor'],
  )
  assert.equal(result.run.tokensUsed, 30)
  assert.equal(result.run.toolsUsed, 1)
  assert.equal(result.run.attemptsUsed, 3)
  assert.notEqual(h.calls[0].permissionDomainId, h.calls[2].permissionDomainId)
})

test('completed Run checkpoint survives the crash-before-publication window without re-execution', async (t) => {
  const h = harness(t)
  // Create a root without allowing its scheduled microtask to execute.
  const detail = await h.service.start(h.start)
  const context = h.service.context(detail.run.id)
  context.controller.abort()
  context.closed = true
  context.clearTimers()
  const now = new Date().toISOString()
  const session = h.store.sessions.create(h.project.id, 'Crashed node')
  const run = h.store.runs.create({
    sessionId: session.id,
    providerId: 'fixture',
    model: 'text',
  })
  const attempt = h.store.workflowAttempts.create({
    id: randomUUID(),
    workflowRunId: detail.run.id,
    nodeId: 'writer',
    attemptNo: 1,
    status: 'running',
    agentRunId: run.id,
    sessionId: session.id,
    inputHash: workflowHash(h.start.inputs),
    tokenBudget: 1000,
    effectStatus: 'possible',
    errorCode: null,
    createdAt: now,
    completedAt: null,
  })
  h.store.transaction(() => {
    h.store.workflowAttempts.stageResult({
      attemptId: attempt.id,
      values: { text: { type: 'text', value: 'persisted' } },
      errorCode: null,
    })
    h.store.runs.finalize(run.id, 'completed')
    h.store.workflowRuns.update({
      ...h.store.workflowRuns.get(detail.run.id),
      attemptsUsed: 1,
      tokensUsed: 10,
    })
  })
  recoverWorkflows(h.store)
  const next = new WorkflowService(h.deps)
  t.after(() => next.dispose())
  const interrupted = next.get(h.project.id, detail.run.id)
  await next.resume({
    projectId: h.project.id,
    runId: detail.run.id,
    stateVersion: interrupted.run.stateVersion,
    acknowledgedAttemptIds: [],
  })
  const result = await until(() => {
    const value = next.get(h.project.id, detail.run.id)
    return value.run.status === 'succeeded' ? value : null
  })
  assert.equal(
    result.outputs.find((item) => item.nodeId === 'writer').values.text.value,
    'persisted',
  )
  assert.deepEqual(
    h.calls.map((call) => call.node.id),
    ['editor'],
  )
})

test('stale output fingerprint blocks resume rather than silently using changed data', async (t) => {
  let fail = true
  const h = harness(t, async (input) => {
    if (input.node.id === 'editor' && fail) {
      fail = false
      throw new Error('synthetic_failure')
    }
    return { text: { type: 'text', value: 'done' } }
  })
  const detail = await done(h, (await h.service.start(h.start)).run.id)
  h.deps.validateResources = async (_projectId, values) => {
    if (values.text?.value === 'done')
      throw new Error('workflow_resource_stale')
  }
  await assert.rejects(
    h.service.resume({
      projectId: h.project.id,
      runId: detail.run.id,
      stateVersion: detail.run.stateVersion,
      acknowledgedAttemptIds: [],
    }),
    /resource_stale/,
  )
  assert.equal(h.calls.length, 2)
})

test('concurrent identical confirmation replies apply once and return the recorded result', async (t) => {
  const h = harness(t, undefined, confirmationFlow())
  const detail = await waiting(h, (await h.service.start(h.start)).run.id)
  const item = detail.confirmations[0]
  const input = {
    requestId: randomUUID(),
    projectId: h.project.id,
    runId: detail.run.id,
    confirmationId: item.id,
    token: item.token,
    inputHash: item.inputHash,
    approved: true,
  }
  const results = await Promise.all([
    h.service.respond(input),
    h.service.respond(input),
  ])
  assert.equal(results[0].outputs.length, results[1].outputs.length)
  assert.equal((await done(h, detail.run.id)).run.status, 'succeeded')
})

test('expired confirmation fails the flow and cannot authorize downstream work', async (t) => {
  const h = harness(t, undefined, confirmationFlow())
  const detail = await waiting(h, (await h.service.start(h.start)).run.id)
  const item = detail.confirmations[0]
  const oldNow = Date.now
  Date.now = () => Date.parse(item.expiresAt) + 1
  try {
    await assert.rejects(
      h.service.respond({
        projectId: h.project.id,
        runId: detail.run.id,
        confirmationId: item.id,
        token: item.token,
        inputHash: item.inputHash,
        approved: true,
      }),
      /confirmation_expired/,
    )
  } finally {
    Date.now = oldNow
  }
  const result = await done(h, detail.run.id)
  assert.equal(result.run.status, 'failed')
  assert.equal(result.confirmations[0].status, 'expired')
  assert.equal(result.outputs.length, 1)
})

test('confirmation expiry is rechecked after asynchronous resource validation', async (t) => {
  const h = harness(t, undefined, confirmationFlow())
  const detail = await waiting(h, (await h.service.start(h.start)).run.id)
  const item = detail.confirmations[0]
  const oldNow = Date.now
  let now = Date.parse(item.expiresAt) - 1
  Date.now = () => now
  h.deps.validateResources = async () => {
    await Promise.resolve()
    now = Date.parse(item.expiresAt) + 1
  }
  try {
    await assert.rejects(
      h.service.respond({
        projectId: h.project.id,
        runId: detail.run.id,
        confirmationId: item.id,
        token: item.token,
        inputHash: item.inputHash,
        approved: true,
      }),
      /confirmation_expired/,
    )
  } finally {
    Date.now = oldNow
  }
  const result = await done(h, detail.run.id)
  assert.equal(result.run.status, 'failed')
  assert.equal(result.confirmations[0].status, 'expired')
  assert.equal(result.outputs.length, 1)
})
