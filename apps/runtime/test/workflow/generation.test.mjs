import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { harness, until } from './harness.mjs'
import { WorkflowGenerationService } from '../../dist/workflow/generation/service.js'
import { dispatchCommand } from '../../dist/handlers.js'
import {
  agentNode,
  textPort,
} from '../../../../packages/contracts/test/fixtures/workflow.mjs'

async function fixture(t, execute) {
  const h = harness(t)
  const calls = []
  const service = new WorkflowGenerationService(
    h.store,
    async (input) => {
      calls.push(input)
      input.onUsage(10, false)
      return execute
        ? execute(input, calls.length)
        : JSON.stringify(h.version.definition)
    },
    h.deps.availableTools,
    h.deps.notify,
  )
  const context = {
    store: h.store,
    workflow: h.service,
    workflowGeneration: service,
  }
  const { draft } = await dispatchCommand(
    'workflow.draft.save',
    {
      requestId: randomUUID(),
      projectId: h.project.id,
      baseRevision: 0,
      definitionId: null,
      baseVersion: 0,
      definition: h.version.definition,
    },
    context,
  )
  const input = {
    requestId: randomUUID(),
    projectId: h.project.id,
    draftId: draft.id,
    baseRevision: draft.revision,
    mode: 'graph',
    description: 'Create a writing workflow',
    providerId: 'fixture',
    model: 'text',
  }
  return { ...h, service, context, draft, calls, input }
}
const settled = (h, id) =>
  until(() => {
    const value = h.service.get(h.project.id, id)
    return value.status !== 'running' && value
  })

test('generation, apply, save and execution are separate; provenance is server-owned and sticky', async (t) => {
  const h = await fixture(t)
  const first = h.service.start(h.input)
  const value = await settled(h, first.id)
  assert.equal(value.status, 'ready')
  assert.equal(h.store.workflowRuns.list(h.project.id).length, 0)
  assert.equal(h.store.workflows.list(h.project.id).length, 1)
  assert.equal(h.store.workflowDrafts.get(h.project.id, h.draft.id).revision, 1)
  assert.notEqual(value.candidate.nodes[0].id, h.version.definition.nodes[0].id)
  assert.equal(h.service.start(h.input).id, first.id)
  assert.equal(h.calls.length, 1)
  const apply = {
    requestId: randomUUID(),
    projectId: h.project.id,
    generationId: first.id,
    stateVersion: value.stateVersion,
  }
  const draft = h.service.apply(apply)
  assert.equal(draft.revision, 2)
  assert.deepEqual(h.service.apply(apply), draft)
  assert.equal(h.store.workflows.list(h.project.id).length, 1)
  const { version } = await dispatchCommand(
    'workflow.save',
    {
      requestId: randomUUID(),
      projectId: h.project.id,
      draftId: draft.id,
      baseRevision: 0,
      definition: draft.definition,
    },
    h.context,
  )
  assert.equal(version.origin, 'nl-generated')
  const linked = h.store.workflowDrafts.get(h.project.id, draft.id)
  assert.equal(linked.definitionId, version.definitionId)
  assert.equal(linked.baseVersion, version.revision)
  assert.equal(linked.revision, draft.revision + 1)
  const next = await dispatchCommand(
    'workflow.save',
    {
      requestId: randomUUID(),
      projectId: h.project.id,
      definitionId: version.definitionId,
      baseRevision: 1,
      definition: { ...version.definition, name: 'Edited' },
    },
    h.context,
  )
  assert.equal(next.version.origin, 'nl-generated')
  assert.equal(h.store.workflowRuns.list(h.project.id).length, 0)
  await h.service.dispose()
})

test('version creation and draft linkage roll back together if linkage fails', async (t) => {
  const h = await fixture(t)
  const original = h.store.workflowDrafts.write.bind(h.store.workflowDrafts)
  h.store.workflowDrafts.write = (...args) => {
    original(...args)
    throw new Error('synthetic linkage failure')
  }
  const input = {
    requestId: randomUUID(),
    projectId: h.project.id,
    draftId: h.draft.id,
    baseRevision: 0,
    definition: h.draft.definition,
  }
  await assert.rejects(
    dispatchCommand('workflow.save', input, h.context),
    /Workflow/,
  )
  assert.equal(h.store.workflows.list(h.project.id).length, 1)
  assert.equal(h.store.workflowDrafts.get(h.project.id, h.draft.id).revision, 1)
  h.store.workflowDrafts.write = original
  const first = await dispatchCommand('workflow.save', input, h.context)
  assert.equal(first.draft.baseVersion, 1)
  assert.deepEqual(
    await dispatchCommand('workflow.save', input, h.context),
    first,
  )
  assert.equal(h.store.workflows.list(h.project.id).length, 2)
  await h.service.dispose()
})

test('draft CAS prevents a candidate from overwriting edits made during generation', async (t) => {
  let release
  const h = await fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const value = h.service.start(h.input)
  await until(() => release)
  const edited = { ...h.draft.definition, description: 'New user edit' }
  await dispatchCommand(
    'workflow.draft.save',
    {
      requestId: randomUUID(),
      projectId: h.project.id,
      draftId: h.draft.id,
      baseRevision: 1,
      definitionId: null,
      baseVersion: 0,
      definition: edited,
    },
    h.context,
  )
  release(JSON.stringify(h.version.definition))
  const ready = await settled(h, value.id)
  assert.throws(
    () =>
      h.service.apply({
        requestId: randomUUID(),
        projectId: h.project.id,
        generationId: value.id,
        stateVersion: ready.stateVersion,
      }),
    /draft_conflict/,
  )
  assert.equal(h.service.get(h.project.id, value.id).status, 'ready')
  assert.equal(
    h.store.workflowDrafts.get(h.project.id, h.draft.id).definition.description,
    'New user edit',
  )
  await h.service.dispose()
})

test('malformed output and illegal grants get at most two repairs without executing candidates', async (t) => {
  const h = await fixture(t, (_, count) =>
    count === 1
      ? 'not JSON'
      : JSON.stringify({ ...h.version.definition, grants: ['all'] }),
  )
  const value = await settled(h, h.service.start(h.input).id)
  assert.equal(value.status, 'invalid')
  assert.equal(h.calls.length, 3)
  assert.equal(value.tokensUsed, 30)
  assert.equal(h.store.workflowRuns.list(h.project.id).length, 0)
  assert.ok(h.calls[1].task.includes('validationErrors'))
  await h.service.dispose()
})

test('graph validation errors retain a bounded candidate; no tool auto-repair', async (t) => {
  const h = await fixture(t, () =>
    JSON.stringify({ ...h.version.definition, edges: [] }),
  )
  const value = await settled(h, h.service.start(h.input).id)
  assert.equal(value.status, 'invalid')
  assert.ok(value.candidate)
  assert.equal(value.validation.valid, false)
  assert.throws(
    () =>
      h.service.apply({
        requestId: randomUUID(),
        projectId: h.project.id,
        generationId: value.id,
        stateVersion: value.stateVersion,
      }),
    /generation_invalid/,
  )
  const edit = {
    requestId: randomUUID(),
    projectId: h.project.id,
    generationId: value.id,
    stateVersion: value.stateVersion,
    definition: h.draft.definition,
  }
  const corrected = h.service.edit(edit)
  assert.equal(corrected.status, 'ready')
  assert.ok(corrected.stateVersion > value.stateVersion)
  assert.throws(
    () =>
      h.service.apply({
        requestId: randomUUID(),
        projectId: h.project.id,
        generationId: value.id,
        stateVersion: value.stateVersion,
      }),
    /state_conflict/,
  )
  assert.deepEqual(h.service.edit(edit), corrected)
  assert.throws(
    () => h.service.edit({ ...edit, requestId: randomUUID() }),
    /state_conflict/,
  )
  assert.equal(h.store.workflows.list(h.project.id).length, 1)
  assert.equal(h.store.workflowDrafts.get(h.project.id, h.draft.id).revision, 1)
  await h.service.dispose()
})

test('single-node generation receives port summaries and appends without changing existing prompts', async (t) => {
  const node = agentNode('polisher')
  node.role.policy.allowedTools = []
  const h = await fixture(t, () =>
    JSON.stringify({
      node,
      edges: [
        {
          from: { nodeId: 'editor', portKey: 'text' },
          to: { nodeId: node.id, portKey: 'text' },
        },
      ],
      bindings: [],
      outputs: [
        {
          port: textPort('polished'),
          from: { nodeId: node.id, portKey: 'text' },
        },
      ],
    }),
  )
  const value = await settled(
    h,
    h.service.start({ ...h.input, mode: 'node' }).id,
  )
  assert.equal(value.status, 'ready')
  assert.deepEqual(value.candidate.nodes.slice(0, 2), h.draft.definition.nodes)
  assert.equal(value.candidate.nodes.length, 3)
  assert.ok(
    !h.calls[0].task.includes(h.draft.definition.nodes[0].role.systemPrompt),
  )
  await h.service.dispose()
})

test('late results after cancellation cannot become ready or apply; other projects cannot query', async (t) => {
  let release
  const h = await fixture(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const first = h.service.start(h.input)
  await until(() => release)
  const cancellation = h.service.cancel(h.project.id, first.id)
  release(JSON.stringify(h.version.definition))
  const value = await cancellation
  assert.equal(value.status, 'cancelled')
  assert.equal(value.candidate, null)
  assert.throws(() => h.service.get('another-project', value.id), /not_found/)
  assert.throws(
    () =>
      h.service.apply({
        requestId: randomUUID(),
        projectId: h.project.id,
        generationId: value.id,
        stateVersion: value.stateVersion,
      }),
    /generation_invalid/,
  )
  await h.service.dispose()
})

test('repairs share tokens and frozen model settings; exhaustion prevents further requests', async (t) => {
  const h = await fixture(t, (input) => {
    input.onUsage(33000, true)
    return 'invalid'
  })
  const value = await settled(h, h.service.start(h.input).id)
  assert.equal(value.status, 'failed')
  assert.equal(h.calls.length, 1)
  assert.equal(value.tokensEstimated, true)
  assert.ok(h.calls[0].profile.secretRef)
  await h.service.dispose()
})

test('startup recovery interrupts generation without a new model request and retains candidates', async (t) => {
  const h = await fixture(t)
  const value = h.service.start(h.input)
  h.store.workflowGenerations.recover()
  await h.service.dispose()
  assert.equal(h.calls.length, 0)
  assert.equal(h.service.get(h.project.id, value.id).status, 'interrupted')
  assert.equal(
    h.store.workflowGenerations.list(h.project.id, h.draft.id).length,
    1,
  )
})

test('save rejects a different definition than the persisted draft; draft retries are idempotent', async (t) => {
  const h = await fixture(t)
  await assert.rejects(
    dispatchCommand(
      'workflow.save',
      {
        requestId: randomUUID(),
        projectId: h.project.id,
        draftId: h.draft.id,
        baseRevision: 0,
        definition: { ...h.draft.definition, name: 'Other' },
      },
      h.context,
    ),
    /Workflow/,
  )
  const input = {
    requestId: randomUUID(),
    projectId: h.project.id,
    draftId: h.draft.id,
    baseRevision: 1,
    definitionId: null,
    baseVersion: 0,
    definition: h.draft.definition,
  }
  const first = await dispatchCommand('workflow.draft.save', input, h.context)
  assert.deepEqual(
    await dispatchCommand('workflow.draft.save', input, h.context),
    first,
  )
  await h.service.dispose()
})
