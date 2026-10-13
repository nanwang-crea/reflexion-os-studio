import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  workflowFixture,
  agentNode,
  textPort,
} from '../../../../packages/contracts/test/fixtures/workflow.mjs'
import { harness, until } from './harness.mjs'

function builder() {
  const flow = workflowFixture()
  const roles = [
    ['pm', ['brief'], ['requirements']],
    ['designer', ['requirements'], ['design']],
    ['planner', ['requirements'], ['testPlan']],
    ['developer', ['requirements', 'design', 'testPlan'], ['implementation']],
    ['tester', ['implementation', 'testPlan'], ['review']],
  ]
  const review = {
    key: 'review',
    title: 'review',
    required: true,
    type: 'json',
    schema: {
      type: 'object',
      properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } },
      required: ['verdict'],
      additionalProperties: false,
    },
  }
  flow.inputs = [textPort('brief')]
  flow.nodes = roles.map(([id, inputs, outputs]) => ({
    ...agentNode(id),
    inputs: inputs.map((key) => textPort(key)),
    outputs: outputs.map((key) => (key === 'review' ? review : textPort(key))),
  }))
  flow.nodes[4].outputs = [review]
  flow.nodes.push({
    id: 'accept',
    kind: 'confirmation',
    name: 'Acceptance',
    instruction: 'Review test evidence',
    inputs: [review],
    outputs: [review],
  })
  flow.edges = [
    ['pm', 'requirements', 'designer', 'requirements'],
    ['pm', 'requirements', 'planner', 'requirements'],
    ['pm', 'requirements', 'developer', 'requirements'],
    ['designer', 'design', 'developer', 'design'],
    ['planner', 'testPlan', 'developer', 'testPlan'],
    ['planner', 'testPlan', 'tester', 'testPlan'],
    ['developer', 'implementation', 'tester', 'implementation'],
    ['tester', 'review', 'accept', 'review'],
  ].map(([from, out, to, input]) => ({
    from: { nodeId: from, portKey: out },
    to: { nodeId: to, portKey: input },
  }))
  flow.bindings = [
    {
      source: 'input',
      inputKey: 'brief',
      to: { nodeId: 'pm', portKey: 'brief' },
    },
  ]
  flow.outputs = [
    { port: review, from: { nodeId: 'accept', portKey: 'review' } },
  ]
  return flow
}

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
