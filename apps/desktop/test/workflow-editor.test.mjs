import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WorkflowDefinitionSchema } from '@reflexion-os-studio/contracts'
import {
  workflowFixture,
  agentNode,
} from '../../../packages/contracts/test/fixtures/workflow.mjs'
const directory = mkdtempSync(join(tmpdir(), 'reflexion-workflow-editor-'))
after(() => rmSync(directory, { recursive: true, force: true }))
const outfile = join(directory, 'editor.mjs')
await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  stdin: {
    contents: `
      export * from './frontend/features/automations/editor/definition.ts'
      export * from './frontend/features/automations/run/history.ts'
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  format: 'esm',
  outfile,
})
const {
  createNode,
  newDefinition,
  connectPorts,
  removeNodes,
  mergeWorkflowRuns,
} = await import(pathToFileURL(outfile).href)

test('run refresh retains older pages, deduplicates overlap and ignores stale states', () => {
  const run = (id, stateVersion) => ({ id, stateVersion })
  const loaded = [run('new', 4), run('old', 3)]
  const refreshed = mergeWorkflowRuns(
    loaded,
    [run('newest', 1), run('new', 2)],
    'latest',
  )
  assert.deepEqual(refreshed, [run('newest', 1), run('new', 4), run('old', 3)])
  assert.deepEqual(
    mergeWorkflowRuns(refreshed, [run('old', 4), run('oldest', 1)], 'older'),
    [run('newest', 1), run('new', 4), run('old', 4), run('oldest', 1)],
  )
  assert.deepEqual(loaded, [run('new', 4), run('old', 3)])
})

test('new role and confirmation nodes use distinct IDs, no delegation and matching ports', () => {
  const one = createNode('agent'),
    two = createNode('confirmation')
  assert.notEqual(one.id, two.id)
  assert.equal(one.role.policy.canDelegate, false)
  assert.deepEqual(one.role.policy.allowedTools, [])
  assert.deepEqual(two.inputs, two.outputs)
  assert.ok(WorkflowDefinitionSchema.safeParse(newDefinition()).success)
})
test('connecting cannot create a second producer, cycle or incompatible port', () => {
  const definition = workflowFixture()
  assert.throws(
    () =>
      connectPorts(
        definition,
        { nodeId: 'writer', portKey: 'text' },
        { nodeId: 'editor', portKey: 'text' },
      ),
    /已有来源/,
  )
  definition.bindings = []
  assert.throws(
    () =>
      connectPorts(
        definition,
        { nodeId: 'editor', portKey: 'text' },
        { nodeId: 'writer', portKey: 'text' },
      ),
    /循环/,
  )
  definition.nodes.push(agentNode('other'))
  definition.nodes[2].inputs[0] = {
    key: 'text',
    title: 'object',
    required: true,
    type: 'json',
    schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  }
  assert.throws(
    () =>
      connectPorts(
        definition,
        { nodeId: 'editor', portKey: 'text' },
        { nodeId: 'other', portKey: 'text' },
      ),
    /不匹配/,
  )
})
test('deleting a node removes all references without mutating the saved definition', () => {
  const definition = workflowFixture(),
    before = structuredClone(definition)
  const deleted = removeNodes(definition, new Set(['writer']))
  assert.equal(deleted.nodes.length, 1)
  assert.equal(deleted.edges.length, 0)
  assert.equal(deleted.bindings.length, 0)
  assert.deepEqual(definition, before)
})

test('equivalent JSON port schemas connect regardless of object key order', () => {
  const definition = workflowFixture()
  definition.edges = []
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'integer' } },
    required: ['a', 'b'],
    additionalProperties: false,
  }
  definition.nodes[0].outputs = [
    { key: 'text', title: 'data', required: true, type: 'json', schema },
  ]
  definition.nodes[1].inputs = [
    {
      key: 'text',
      title: 'data',
      required: true,
      type: 'json',
      schema: {
        additionalProperties: false,
        required: ['a', 'b'],
        properties: { b: { type: 'integer' }, a: { type: 'string' } },
        type: 'object',
      },
    },
  ]
  assert.equal(
    connectPorts(
      definition,
      { nodeId: 'writer', portKey: 'text' },
      { nodeId: 'editor', portKey: 'text' },
    ).edges.length,
    1,
  )
})
