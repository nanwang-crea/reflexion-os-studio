import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  workflowFixture,
  agentNode,
  textPort,
} from '../../../../packages/contracts/test/fixtures/workflow.mjs'
import { harness, until } from './harness.mjs'

const terminal = (service, start, id) =>
  until(() => {
    const detail = service.get(start.projectId, id)
    return ['succeeded', 'failed', 'cancelled'].includes(detail.run.status)
      ? detail
      : null
  })

test('serial flow transfers only bound results, hides internal sessions, freezes models and is idempotent', async (t) => {
  const h = harness(t)
  const first = await h.service.start(h.start)
  const result = await terminal(h.service, h.start, first.run.id)
  assert.equal(result.run.status, 'succeeded')
  assert.deepEqual(
    h.calls.map((call) => call.node.id),
    ['writer', 'editor'],
  )
  assert.equal(h.calls[1].inputs.text.value, 'topic/writer')
  assert.equal(result.outputs.at(-1).values.text.value, 'topic/writer/editor')
  assert.equal(result.attempts.length, 2)
  assert.equal(h.store.sessions.list(h.project.id).length, 0)
  assert.equal(h.calls[0].permissionDomainId, h.calls[1].permissionDomainId)
  assert.equal(result.run.tokensUsed, 20)
  assert.equal(
    result.run.snapshot.models[0].profile.secretRef,
    'synthetic-reference',
  )
  assert.ok(
    h.events.every(
      (event) => event.scope === 'workflow' && !('snapshot' in event),
    ),
  )
  assert.equal((await h.service.start(h.start)).run.id, result.run.id)
  await assert.rejects(
    h.service.start({
      ...h.start,
      inputs: { text: { type: 'text', value: 'different' } },
    }),
    /request_conflict/,
  )
  assert.equal(h.cleared.length, 1)
})

test('fork/join respects concurrency and waits for all dependencies', async (t) => {
  const flow = workflowFixture()
  flow.nodes.splice(1, 0, agentNode('ideas'))
  flow.nodes[2].inputs.push(textPort('ideas'))
  flow.bindings.push({
    source: 'input',
    inputKey: 'text',
    to: { nodeId: 'ideas', portKey: 'text' },
  })
  flow.edges.push({
    from: { nodeId: 'ideas', portKey: 'text' },
    to: { nodeId: 'editor', portKey: 'ideas' },
  })
  let active = 0,
    peak = 0
  const done = []
  const h = harness(
    t,
    async (input) => {
      peak = Math.max(peak, ++active)
      if (input.node.id === 'editor')
        assert.deepEqual(new Set(done), new Set(['writer', 'ideas']))
      await delay(input.node.id === 'writer' ? 30 : 10)
      --active
      done.push(input.node.id)
      return { text: { type: 'text', value: input.node.id } }
    },
    flow,
  )
  const result = await terminal(
    h.service,
    h.start,
    (await h.service.start(h.start)).run.id,
  )
  assert.equal(result.run.status, 'succeeded')
  assert.equal(peak, 2)
  assert.equal(h.calls[2].inputs.ideas.value, 'ideas')
})

test('failure cancels siblings, prevents downstream, and invalid output is never published', async (t) => {
  const h = harness(t, async () => ({
    wrong: { type: 'text', value: 'invalid' },
  }))
  const result = await terminal(
    h.service,
    h.start,
    (await h.service.start(h.start)).run.id,
  )
  assert.equal(result.run.status, 'failed')
  assert.equal(result.run.errorCode, 'output_validation_failed')
  assert.equal(result.outputs.length, 0)
  assert.equal(h.calls.length, 1)
})

test('cancelled execution cannot publish a late success or start downstream', async (t) => {
  let release
  const h = harness(t, async () => {
    await new Promise((resolve) => {
      release = resolve
    })
    return { text: { type: 'text', value: 'late' } }
  })
  const started = await h.service.start(h.start)
  await until(() => release)
  const cancellation = h.service.cancel(h.start.projectId, started.run.id)
  release()
  await cancellation
  const result = await terminal(h.service, h.start, started.run.id)
  assert.equal(result.run.status, 'cancelled')
  assert.equal(result.outputs.length, 0)
  assert.equal(h.calls.length, 1)
})

test('shared tool budget and effect marking survive failure', async (t) => {
  const flow = workflowFixture()
  flow.budget.maxToolCalls = 10
  const h = harness(
    t,
    async (input) => {
      input.onToolBatch(Array(6).fill('file.write'))
      input.beforeToolInvoke('file.write')
      return { text: { type: 'text', value: 'done' } }
    },
    flow,
  )
  const result = await terminal(
    h.service,
    h.start,
    (await h.service.start(h.start)).run.id,
  )
  assert.equal(result.run.status, 'failed')
  assert.equal(result.run.errorCode, 'workflow_tool_budget')
  assert.equal(result.run.toolsUsed, 6)
  assert.equal(result.attempts[0].effectStatus, 'possible')
  assert.equal(result.outputs.length, 1)
})

test('shared mutation lane serializes parallel writes', async (t) => {
  const flow = workflowFixture()
  flow.edges = []
  flow.bindings.push({
    source: 'input',
    inputKey: 'text',
    to: { nodeId: 'editor', portKey: 'text' },
  })
  flow.outputs.push({
    port: textPort('first'),
    from: { nodeId: 'writer', portKey: 'text' },
  })
  let inside = 0,
    peak = 0
  const h = harness(
    t,
    async (input) => {
      await input.mutationCoordinator.run(async () => {
        peak = Math.max(peak, ++inside)
        await delay(15)
        --inside
      })
      return { text: { type: 'text', value: 'done' } }
    },
    flow,
  )
  const result = await terminal(
    h.service,
    h.start,
    (await h.service.start(h.start)).run.id,
  )
  assert.equal(result.run.status, 'succeeded')
  assert.equal(peak, 1)
})

test('root token and attempt budgets cannot be replenished by manual retry', async (t) => {
  const h = harness(t, async (input) => {
    input.onModelResult({ promptTokens: 9000, completionTokens: 100 })
    return { text: { type: 'text', value: 'over budget' } }
  })
  const detail = await terminal(
    h.service,
    h.start,
    (await h.service.start(h.start)).run.id,
  )
  assert.equal(detail.run.status, 'failed')
  assert.equal(detail.run.errorCode, 'workflow_token_budget')
  await assert.rejects(
    h.service.resume({
      projectId: h.project.id,
      runId: detail.run.id,
      stateVersion: detail.run.stateVersion,
      acknowledgedAttemptIds: [],
    }),
    /budget_exhausted/,
  )
  assert.equal(h.calls.length, 1)
  assert.ok(detail.run.tokensUsed > 8000)
})

test('failed branch aborts an active sibling and no join is executed', async (t) => {
  const flow = workflowFixture()
  const sibling = agentNode('ideas')
  flow.nodes.splice(1, 0, sibling)
  flow.nodes[2].inputs.push(textPort('ideas'))
  flow.bindings.push({
    source: 'input',
    inputKey: 'text',
    to: { nodeId: 'ideas', portKey: 'text' },
  })
  flow.edges.push({
    from: { nodeId: 'ideas', portKey: 'text' },
    to: { nodeId: 'editor', portKey: 'ideas' },
  })
  let siblingCancelled = false
  const h = harness(
    t,
    async (input) => {
      if (input.node.id === 'writer') {
        await delay(15)
        throw new Error('synthetic_failure')
      }
      await new Promise((resolve) =>
        input.signal.addEventListener(
          'abort',
          () => {
            siblingCancelled = true
            resolve()
          },
          { once: true },
        ),
      )
      return { text: { type: 'text', value: 'late sibling' } }
    },
    flow,
  )
  const detail = await terminal(
    h.service,
    h.start,
    (await h.service.start(h.start)).run.id,
  )
  assert.equal(detail.run.status, 'failed')
  assert.equal(siblingCancelled, true)
  assert.equal(detail.outputs.length, 0)
  assert.deepEqual(
    h.calls.map((call) => call.node.id),
    ['writer', 'ideas'],
  )
})

test('retry creates an attempt only while the original attempt budget remains', async (t) => {
  const flow = workflowFixture()
  flow.budget.maxAttempts = 2
  const h = harness(
    t,
    async (input) => {
      if (input.node.id === 'editor') throw new Error('synthetic_failure')
      return { text: { type: 'text', value: 'done' } }
    },
    flow,
  )
  const detail = await terminal(
    h.service,
    h.start,
    (await h.service.start(h.start)).run.id,
  )
  await h.service.resume({
    projectId: h.project.id,
    runId: detail.run.id,
    stateVersion: detail.run.stateVersion,
    acknowledgedAttemptIds: [],
  })
  const result = await terminal(h.service, h.start, detail.run.id)
  assert.equal(result.run.errorCode, 'workflow_attempt_budget')
  assert.equal(result.run.attemptsUsed, 2)
  assert.equal(h.calls.length, 2)
})

test('optional port names cannot read inherited object properties', async (t) => {
  const flow = workflowFixture()
  flow.inputs = [textPort('constructor', false)]
  flow.nodes[0].inputs = [textPort('constructor', false)]
  flow.bindings = [
    {
      source: 'input',
      inputKey: 'constructor',
      to: { nodeId: 'writer', portKey: 'constructor' },
    },
  ]
  const h = harness(t, undefined, flow)
  const started = await h.service.start({ ...h.start, inputs: {} })
  const result = await terminal(h.service, h.start, started.run.id)
  assert.equal(result.run.status, 'succeeded')
  assert.equal(Object.hasOwn(h.calls[0].inputs, 'constructor'), false)
})
