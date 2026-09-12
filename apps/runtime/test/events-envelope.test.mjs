import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTOCOL_VERSION,
  RuntimeEventSchema,
} from '@reflexion-os-studio/contracts'
import { ResourceEventEmitter, RunEventEmitter } from '../dist/events.js'

test('ResourceEventEmitter(runtime) 不带 runId 且 scope=runtime', () => {
  const events = []
  const emitter = new ResourceEventEmitter({ scope: 'runtime' }, (e) =>
    events.push(e),
  )
  emitter.next({
    type: 'runtime.status',
    status: {
      state: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: '0.1.0',
      capabilities: ['chat'],
      chatAvailable: true,
      systemAvailable: false,
    },
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].scope, 'runtime')
  assert.equal('runId' in events[0], false)
  assert.equal(RuntimeEventSchema.safeParse(events[0]).success, true)
})

test('RunEventEmitter 保持 (runId, notifier) 构造与 .runId 访问器', () => {
  const events = []
  const emitter = new RunEventEmitter('r1', (e) => events.push(e))
  emitter.next({ type: 'run.completed' })
  assert.equal(emitter.runId, 'r1')
  assert.equal(events[0].scope, 'run')
  assert.equal(events[0].runId, 'r1')
})

test('作用域错配（session 发射器发 run 事件）必须抛错', () => {
  const emitter = new ResourceEventEmitter(
    { scope: 'session', sessionId: 's1' },
    () => undefined,
  )
  assert.throws(() => emitter.next({ type: 'run.completed' }))
})

test('seq 在同一发射器实例内单调递增', () => {
  const events = []
  const emitter = new ResourceEventEmitter(
    { scope: 'session', sessionId: 's1' },
    (e) => events.push(e),
  )
  const payload = { type: 'queue.changed', sessionId: 's1', items: [] }
  emitter.next(payload)
  emitter.next(payload)
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1],
  )
})
