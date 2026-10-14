import assert from 'node:assert/strict'
import { test } from 'node:test'
import { builder } from '../../../../packages/contracts/test/fixtures/builder.mjs'
import { harness, until } from './harness.mjs'

test('Builder plans in parallel, joins requirements, validates a test verdict, and waits for user acceptance', async (t) => {
  const h = harness(
    t,
    async (input) => {
      if (input.node.id === 'developer')
        assert.deepEqual(Object.keys(input.inputs).sort(), [
          'design',
          'requirements',
          'testPlan',
        ])
      if (input.node.id === 'tester')
        return { review: { type: 'json', value: { verdict: 'pass' } } }
      return Object.fromEntries(
        input.node.outputs.map((port) => [
          port.key,
          { type: 'text', value: `${input.node.id} evidence` },
        ]),
      )
    },
    builder(),
  )
  const started = await h.service.start({
    ...h.start,
    inputs: { brief: { type: 'text', value: 'Build a synthetic app' } },
  })
  const waiting = await until(() => {
    const detail = h.service.get(h.project.id, started.run.id)
    return detail.run.status === 'waiting_user' ? detail : null
  })
  assert.equal(h.calls.length, 5)
  assert.equal(
    waiting.outputs.find((item) => item.nodeId === 'tester').values.review.value
      .verdict,
    'pass',
  )
  const item = waiting.confirmations[0]
  await h.service.respond({
    projectId: h.project.id,
    runId: waiting.run.id,
    confirmationId: item.id,
    inputHash: item.inputHash,
    token: item.token,
    approved: true,
  })
  const result = await until(() => {
    const detail = h.service.get(h.project.id, waiting.run.id)
    return detail.run.status === 'succeeded' ? detail : null
  })
  assert.equal(result.result.review.value.verdict, 'pass')
})
