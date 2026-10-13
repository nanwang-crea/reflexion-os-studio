import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateWorkflow } from '../../dist/workflow/graph/validate.js'
import { validatePortValues } from '../../dist/workflow/graph/ports.js'
import {
  jsonSchemaIssues,
  matchesJsonSchema,
  canonicalJson,
} from '../../dist/workflow/graph/json-schema.js'
import {
  workflowFixture,
  agentNode,
  textPort,
} from '../../../../packages/contracts/test/fixtures/workflow.mjs'

const errors = (flow) => validateWorkflow(flow).issues.map((item) => item.code)

test('serial writing flow and fork/join validate in deterministic order', () => {
  const flow = workflowFixture()
  assert.deepEqual(validateWorkflow(flow), {
    valid: true,
    issues: [],
    order: ['writer', 'editor'],
  })
  flow.nodes.splice(1, 0, agentNode('ideas'))
  flow.bindings.push({
    source: 'input',
    inputKey: 'text',
    to: { nodeId: 'ideas', portKey: 'text' },
  })
  flow.nodes[2].inputs.push(textPort('ideas'))
  flow.edges.push({
    from: { nodeId: 'ideas', portKey: 'text' },
    to: { nodeId: 'editor', portKey: 'ideas' },
  })
  assert.deepEqual(validateWorkflow(flow).order, ['writer', 'ideas', 'editor'])
})

test('rejects cycles, missing nodes, duplicate IDs and invalid layout', () => {
  const flow = workflowFixture()
  flow.edges.push({
    from: { nodeId: 'editor', portKey: 'text' },
    to: { nodeId: 'writer', portKey: 'text' },
  })
  assert.ok(errors(flow).includes('cycle'))
  assert.ok(errors(flow).includes('multiple_sources'))
  flow.edges.pop()
  flow.nodes.push(agentNode('writer'))
  assert.ok(errors(flow).includes('duplicate_node'))
  flow.nodes.pop()
  flow.edges[0].from.nodeId = 'missing'
  assert.ok(errors(flow).includes('missing_node'))
  flow.edges[0].from.nodeId = 'writer'
  flow.layout = [
    { nodeId: 'writer', x: 0, y: 0 },
    { nodeId: 'writer', x: 1, y: 2 },
  ]
  assert.ok(errors(flow).includes('invalid_layout'))
})

test('requiredness, single binding and output reachability are enforced', () => {
  const flow = workflowFixture()
  flow.nodes[0].outputs[0].required = false
  assert.ok(errors(flow).includes('port_incompatible'))
  flow.nodes[0].outputs[0].required = true
  flow.bindings = []
  assert.ok(errors(flow).includes('unbound_input'))
  flow.nodes.push(agentNode('orphan'))
  assert.ok(errors(flow).includes('orphan_node'))
})

test('duplicate ports, incompatible constants and budgets fail early', () => {
  const flow = workflowFixture()
  flow.nodes[0].inputs.push(textPort())
  assert.ok(errors(flow).includes('duplicate_port'))
  flow.nodes[0].inputs.pop()
  flow.bindings = [
    {
      source: 'constant',
      value: { type: 'json', value: 1 },
      to: { nodeId: 'writer', portKey: 'text' },
    },
  ]
  assert.ok(errors(flow).includes('constant_incompatible'))
  flow.budget.maxAttempts = 1
  flow.nodes[0].budget.maxTokens = 10000
  assert.ok(errors(flow).includes('attempt_budget'))
  assert.ok(errors(flow).includes('node_budget_exceeds_flow'))
  flow.nodes[0].role.policy.allowedTools.push('task')
  assert.ok(errors(flow).includes('delegation_disabled'))
})

test('confirmation only forwards explicitly matching inputs', () => {
  const flow = workflowFixture()
  flow.nodes[1] = {
    id: 'editor',
    name: 'Review',
    kind: 'confirmation',
    instruction: 'Approve the text?',
    inputs: [textPort()],
    outputs: [textPort()],
  }
  assert.equal(validateWorkflow(flow).valid, true)
  flow.nodes[1].outputs[0].key = 'transformed'
  assert.ok(errors(flow).includes('confirmation_mapping'))
})

test('JSON compatibility is canonical equality, not a guessed subtype', () => {
  const flow = workflowFixture()
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  }
  const port = { ...textPort(), type: 'json', schema }
  flow.nodes[0].outputs = [port]
  flow.nodes[1].inputs = [
    {
      ...port,
      schema: {
        additionalProperties: false,
        required: ['title'],
        properties: schema.properties,
        type: 'object',
      },
    },
  ]
  assert.equal(validateWorkflow(flow).valid, true)
  flow.nodes[1].inputs[0].schema = { type: 'object' }
  assert.ok(errors(flow).includes('port_incompatible'))
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }))
})

test('JSON schema semantics and result contracts reject invalid publication', () => {
  const schema = {
    type: 'object',
    properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } },
    required: ['verdict'],
    additionalProperties: false,
  }
  assert.deepEqual(jsonSchemaIssues(schema), [])
  assert.equal(matchesJsonSchema({ verdict: 'fail' }, schema), true)
  assert.equal(matchesJsonSchema({ verdict: 'unknown' }, schema), false)
  assert.equal(
    matchesJsonSchema({ verdict: 'pass', extra: true }, schema),
    false,
  )
  assert.ok(jsonSchemaIssues({ type: 'object', required: ['missing'] }).length)
  assert.ok(jsonSchemaIssues({ type: 'array' }).length)
  assert.ok(jsonSchemaIssues({ type: 'number', minimum: 5, maximum: 2 }).length)
  assert.ok(jsonSchemaIssues({ type: 'string', minimum: 0 }).length)
  assert.ok(jsonSchemaIssues({ type: 'integer', enum: [1.5] }).length)
  assert.equal(matchesJsonSchema('😀', { type: 'string', maxLength: 1 }), true)
  const ports = [{ ...textPort(), type: 'json', schema }]
  assert.deepEqual(
    validatePortValues(ports, {
      text: { type: 'json', value: { verdict: 'fail' } },
    }),
    [],
  )
  assert.equal(validatePortValues(ports, {}).length, 1)
  assert.equal(
    validatePortValues(ports, {
      text: { type: 'json', value: { verdict: 'unknown' } },
    }).length,
    1,
  )
})

test('malformed and oversized generated definitions fail without recursion', () => {
  assert.equal(validateWorkflow({ schemaVersion: 1 }).valid, false)
  const flow = workflowFixture()
  flow.grant = 'approved'
  assert.ok(errors(flow).includes('schema_invalid'))
  let nested = {}
  const root = nested
  for (let i = 0; i < 2000; i++) {
    nested.child = {}
    nested = nested.child
  }
  assert.ok(errors(root).includes('definition_limit'))
})
