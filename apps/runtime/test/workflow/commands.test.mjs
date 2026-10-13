import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { dispatchCommand } from '../../dist/handlers.js'
import { requireSession } from '../../dist/agent/guards.js'
import { harness, until } from './harness.mjs'

const context = (h) => ({ store: h.store, workflow: h.service })

test('save request survives replay and conflicting payloads cannot create extra versions', async (t) => {
  const h = harness(t)
  const input = {
    requestId: randomUUID(),
    projectId: h.project.id,
    baseRevision: 0,
    definition: h.version.definition,
  }
  const first = await dispatchCommand('workflow.save', input, context(h))
  const second = await dispatchCommand('workflow.save', input, context(h))
  assert.deepEqual(first, second)
  assert.equal(h.store.workflows.list(h.project.id).length, 2)
  await assert.rejects(
    dispatchCommand(
      'workflow.save',
      { ...input, definition: { ...input.definition, name: 'changed' } },
      context(h),
    ),
    { code: 'workflow_state_conflict' },
  )
})

test('runtime command path starts, queries, and guards project/internal session deletion', async (t) => {
  let release
  const h = harness(t, async () => {
    await new Promise((resolve) => {
      release = resolve
    })
    return { text: { type: 'text', value: 'done' } }
  })
  const { detail } = await dispatchCommand(
    'workflow.run.start',
    { ...h.start, defaultModel: { ...h.start.defaultModel, mode: 'explicit' } },
    context(h),
  )
  await until(() => release)
  const attempt = h.service.get(h.project.id, detail.run.id).attempts[0]
  assert.throws(() => requireSession(h.store, attempt.sessionId), /Workflow/)
  await assert.rejects(
    dispatchCommand(
      'session.delete',
      { sessionId: attempt.sessionId },
      context(h),
    ),
    /Workflow/,
  )
  await assert.rejects(
    dispatchCommand('project.delete', { projectId: h.project.id }, context(h)),
    /Workflow/,
  )
  await assert.rejects(
    dispatchCommand(
      'workflow.archive',
      {
        requestId: randomUUID(),
        projectId: h.project.id,
        definitionId: h.version.definitionId,
        baseRevision: 1,
      },
      context(h),
    ),
    /归档/,
  )
  const cancellation = h.service.cancel(h.project.id, detail.run.id)
  release()
  await cancellation
  assert.equal(
    h.service.get(h.project.id, detail.run.id).run.status,
    'cancelled',
  )
})

test('scope mismatch and unregistered tools fail before Agent execution', async (t) => {
  const h = harness(t)
  const other = h.store.projects.create({ name: 'Other', folderPath: '' })
  await assert.rejects(
    h.service.start({ ...h.start, projectId: other.id }),
    /definition_unavailable/,
  )
  const flow = structuredClone(h.version.definition)
  flow.nodes[0].role.policy.allowedTools = ['unregistered/tool']
  const { version } = await dispatchCommand(
    'workflow.save',
    {
      requestId: randomUUID(),
      projectId: h.project.id,
      baseRevision: 0,
      definition: flow,
    },
    context(h),
  )
  await assert.rejects(
    h.service.start({
      ...h.start,
      requestId: randomUUID(),
      definitionId: version.definitionId,
    }),
    /configuration_unavailable/,
  )
  assert.equal(h.calls.length, 0)
})

test('deleting a project also removes durable request replay data', async (t) => {
  const h = harness(t)
  const input = {
    requestId: randomUUID(),
    projectId: h.project.id,
    baseRevision: 0,
    definition: h.version.definition,
  }
  await dispatchCommand('workflow.save', input, context(h))
  h.store.projects.delete(h.project.id)
  const { workflowHash } =
    await import('../../dist/workflow/execution/resources.js')
  assert.equal(
    h.store.workflowRuns.requestResult(
      input.requestId,
      'workflow.save',
      workflowHash({ ...input, id: undefined, origin: 'manual' }),
    ),
    null,
  )
})
