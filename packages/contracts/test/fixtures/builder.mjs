import { workflowFixture, agentNode, textPort } from './workflow.mjs'

export function builder() {
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
