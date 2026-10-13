import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { assertWorkflowValuesSafe } from '../../dist/workflow/security/content.js'
import { saveWorkflowDefinition } from '../../dist/workflow/definitions/service.js'
import { harness } from './harness.mjs'

test('known credential-shaped definitions and inputs are rejected without storing them', async (t) => {
  const h = harness(t)
  const synthetic = `sk-${'x'.repeat(24)}`
  const definition = structuredClone(h.version.definition)
  definition.nodes[0].role.systemPrompt = synthetic
  assert.throws(
    () =>
      saveWorkflowDefinition(h.store, {
        projectId: h.project.id,
        baseRevision: 0,
        definition,
        origin: 'manual',
      }),
    /sensitive_content/,
  )
  assert.equal(h.store.workflows.list(h.project.id).length, 1)
  await assert.rejects(
    h.service.start({
      ...h.start,
      requestId: randomUUID(),
      inputs: { text: { type: 'text', value: synthetic } },
    }),
    /sensitive_content/,
  )
  assert.equal(h.calls.length, 0)
  assert.doesNotThrow(() =>
    assertWorkflowValuesSafe({ text: { type: 'text', value: 'a'.repeat(64) } }),
  )
})
