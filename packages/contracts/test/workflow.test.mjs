import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  WorkflowDefinitionSchema,
  WorkflowValueSchema,
  WorkflowJsonSchemaSchema,
  workflowValueWithinBounds,
  jsonSchemas,
} from '../dist/index.js'
import { workflowFixture } from './fixtures/workflow.mjs'

test('workflow is strict, language-only and cannot authorize delegation', () => {
  const base = workflowFixture()
  assert.equal(WorkflowDefinitionSchema.safeParse(base).success, true)
  assert.equal(
    WorkflowDefinitionSchema.safeParse({ ...base, grant: 'approved' }).success,
    false,
  )
  base.nodes[0].role.policy.canDelegate = true
  assert.equal(WorkflowDefinitionSchema.safeParse(base).success, false)
  base.nodes[0].role.policy.canDelegate = false
  base.nodes[0].kind = 'image'
  assert.equal(WorkflowDefinitionSchema.safeParse(base).success, false)
})

test('recursive schema stays typed and rejects unsupported keywords', () => {
  const schema = {
    type: 'object',
    properties: {
      sections: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' } } },
      },
    },
  }
  assert.equal(WorkflowJsonSchemaSchema.safeParse(schema).success, true)
  schema.properties.sections.items.properties.title.$ref =
    'https://example.com/schema'
  assert.equal(WorkflowJsonSchemaSchema.safeParse(schema).success, false)
})

test('untrusted JSON is bounded before recursive validation', () => {
  let deep = 'leaf'
  for (let i = 0; i < 1000; i++) deep = { child: deep }
  assert.equal(workflowValueWithinBounds(deep), false)
  assert.equal(
    WorkflowValueSchema.safeParse({ type: 'json', value: deep }).success,
    false,
  )
  const cycle = {}
  cycle.self = cycle
  assert.equal(workflowValueWithinBounds(cycle), false)
  assert.equal(workflowValueWithinBounds(Array(5000).fill(0)), false)
  assert.equal(workflowValueWithinBounds('界'.repeat(100000)), false)
})

test('resource values require fingerprints, not credential or arbitrary URL fields', () => {
  assert.equal(
    WorkflowValueSchema.safeParse({
      type: 'resource',
      value: {
        kind: 'asset',
        assetId: 'fixture',
        hash: 'a'.repeat(64),
      },
    }).success,
    true,
  )
  assert.equal(
    WorkflowValueSchema.safeParse({
      type: 'resource',
      value: {
        kind: 'asset',
        assetId: 'fixture',
      },
    }).success,
    false,
  )
  assert.equal(
    WorkflowValueSchema.safeParse({
      type: 'resource',
      value: {
        kind: 'externalUrl',
        uri: 'https://example.com',
      },
    }).success,
    false,
  )
})

test('workflow JSON Schema export supports future natural-language generation', () => {
  const schema = jsonSchemas.WorkflowDefinition
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.ok(schema.properties.nodes)
  assert.ok(jsonSchemas.WorkflowExecutionSnapshot)
  assert.ok(jsonSchemas.WorkflowAttempt)
})

test('aggregate result values cannot exceed the shared JSON budget', async () => {
  const { WorkflowValuesSchema } = await import('../dist/index.js')
  const values = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [
      `port${i}`,
      { type: 'text', value: '界'.repeat(65536) },
    ]),
  )
  assert.equal(WorkflowValuesSchema.safeParse(values).success, false)
})
