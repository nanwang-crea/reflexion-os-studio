import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StreamingReadCoordinator } from '../../dist/agent/run/streaming/reads.js'
import { executeToolBatch } from '../../dist/agent/run/tool-scheduler.js'
import { fixture, request, deferred, tick } from './fixture.mjs'

function setup(t, override) {
  const f = fixture(t, 'workspace-read', override)
  const calls = []
  f.registry.register({
    name: 'file.read',
    description: 'test read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execution: { effect: 'read' },
    execute: async ({ args, signal }) => {
      signal.throwIfAborted()
      calls.push(args.path)
      return { content: args.path, isError: false }
    },
  })
  const controller = new AbortController()
  let admitted = 0
  const coordinator = new StreamingReadCoordinator(f, {
    signal: controller.signal,
    admit: () => {
      admitted++
      return true
    },
  })
  return { ...f, coordinator, controller, calls, admitted: () => admitted }
}

test('progress never executes; a closed read runs once and its audited result is reused', async (t) => {
  const f = setup(t)
  const call = request('read', 'file.read', { path: 'a.ts' })
  f.coordinator.observe(call)
  await tick()
  assert.deepEqual(f.calls, [])
  f.coordinator.accept(call)
  f.coordinator.accept(call)
  await tick()
  assert.deepEqual(f.calls, ['a.ts'])
  await f.coordinator.finish([call], 'tool_calls')
  const results = await executeToolBatch(
    {
      ...f,
      completedCalls: f.coordinator.completed,
      executeOne: () => {
        throw new Error('duplicate execution')
      },
    },
    [call],
    f.controller.signal,
  )
  assert.equal(results[0].content, 'a.ts')
  assert.equal(f.store.toolCalls.listByRun(f.run.id).length, 1)
  assert.equal(f.admitted(), 1)
  assert.equal(f.store.runs.get(f.run.id).performance.streamedReads, 1)
})

test('ask-everything, invalid args and a preceding write defer execution', async (t) => {
  const f = setup(t, 'ask-everything')
  f.coordinator.accept(request('r', 'file.read', { path: 'a.ts' }))
  await tick()
  assert.deepEqual(f.calls, [])
  const g = setup(t)
  g.coordinator.accept(request('bad', 'file.read', {}))
  g.coordinator.observe(
    request('write', 'file.write', { path: 'a.ts', content: 'x' }),
  )
  g.coordinator.accept(request('r', 'file.read', { path: 'b.ts' }))
  await tick()
  assert.deepEqual(g.calls, [])
  assert.equal(g.admitted(), 0)
})

test('retry discards stale results and detaches abandoned reads from model history', async (t) => {
  const f = setup(t)
  const call = request('same-id', 'file.read', { path: 'a.ts' })
  f.coordinator.accept(call)
  await tick()
  f.coordinator.reset()
  f.coordinator.accept(call)
  await f.coordinator.finish([call], 'tool_calls')
  assert.deepEqual(f.calls, ['a.ts', 'a.ts'])
  const rows = f.store.toolCalls.listByRun(f.run.id)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].messageId, null)
  assert.equal(rows[1].messageId, f.state.lastAssistantMessageId)
  assert.equal(f.state.precreatedToolCallRows.get(call.id), rows[1].id)
})

test('truncated responses never promote reads; mismatched final arguments are rejected', async (t) => {
  const f = setup(t),
    call = request('r', 'file.read', { path: 'a.ts' })
  f.coordinator.accept(call)
  await f.coordinator.finish([call], 'length')
  assert.equal(f.coordinator.completed.size, 0)
  assert.equal(f.store.toolCalls.listByRun(f.run.id)[0].messageId, null)
  f.coordinator.accept(call)
  await assert.rejects(
    f.coordinator.finish(
      [request('r', 'file.read', { path: 'b.ts' })],
      'tool_calls',
    ),
    /differ/,
  )
  assert.equal(f.coordinator.completed.size, 0)
})

test('semantic argument equality permits protocol normalization without reexecution', async (t) => {
  const f = setup(t),
    call = request('r', 'file.read', { path: 'a.ts' })
  f.coordinator.accept({ ...call, arguments: '{ "path": "a.ts" }' })
  await f.coordinator.finish([call], 'tool_calls')
  assert.equal(f.coordinator.completed.size, 1)
})

test('cancellation drains an in-flight early read and finalizes its audit row', async (t) => {
  const f = setup(t),
    entered = deferred()
  f.registry.register({
    name: 'file.list',
    description: 'slow',
    parameters: { type: 'object' },
    execution: { effect: 'read' },
    execute: async ({ signal }) => {
      entered.resolve()
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      )
      return { content: '', isError: false }
    },
  })
  f.coordinator.accept(request('r', 'file.list', { path: 'src' }))
  await entered.promise
  f.controller.abort()
  await f.coordinator.abandon()
  const row = f.store.toolCalls.listByRun(f.run.id)[0]
  assert.equal(row.messageId, null)
  assert.equal(row.status, 'cancelled')
  assert.equal(f.state.toolCallRowIds.size, 0)
})

test('later Run failure preserves promoted declarations for native history replay', async (t) => {
  const f = setup(t),
    call = request('r', 'file.read', { path: 'a.ts' })
  f.coordinator.accept(call)
  await f.coordinator.finish([call], 'tool_calls')
  await f.coordinator.abandon()
  assert.equal(
    f.store.toolCalls.listByRun(f.run.id)[0].messageId,
    f.state.lastAssistantMessageId,
  )
})
