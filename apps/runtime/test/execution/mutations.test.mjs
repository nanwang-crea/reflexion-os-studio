import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RootMutationCoordinator } from '../../dist/agent/delegation/mutations.js'
import {
  resourcesConflict,
  fileResourceKeys,
} from '../../dist/agent/delegation/resource-locks.js'
import { planBatches } from '../../dist/agent/run/tool-scheduler.js'
import { deferred, tick } from './fixture.mjs'

test('disjoint edits overlap; same path and Shell barriers preserve admission order', async () => {
  const lock = new RootMutationCoordinator()
  const a = deferred(),
    b = deferred()
  const events = []
  const first = lock.run(
    async () => {
      events.push('a')
      await a.promise
    },
    { keys: ['workspace:a'] },
  )
  const second = lock.run(
    async () => {
      events.push('b')
      await b.promise
    },
    { keys: ['workspace:b'] },
  )
  const shell = lock.run(async () => {
    events.push('shell')
  })
  const later = lock.run(
    async () => {
      events.push('later')
    },
    { keys: ['workspace:c'] },
  )
  await tick()
  assert.deepEqual(events, ['a', 'b'])
  a.resolve()
  await tick()
  assert.deepEqual(events, ['a', 'b'])
  b.resolve()
  await Promise.all([first, second, shell, later])
  assert.deepEqual(events, ['a', 'b', 'shell', 'later'])
})

test('cancelled waiter never runs and cannot let a later barrier overtake an active edit', async () => {
  const lock = new RootMutationCoordinator(),
    active = deferred(),
    controller = new AbortController()
  const events = []
  const first = lock.run(() => active.promise, { keys: ['workspace:a'] })
  const cancelled = lock.run(
    async () => {
      events.push('cancelled')
    },
    { keys: ['workspace:a'], signal: controller.signal },
  )
  controller.abort()
  await assert.rejects(cancelled)
  const barrier = lock.run(async () => {
    events.push('barrier')
  })
  await tick()
  assert.deepEqual(events, [])
  active.resolve()
  await Promise.all([first, barrier])
  assert.deepEqual(events, ['barrier'])
})

test('path keys handle separators, ancestors and unknown scopes conservatively', () => {
  assert.deepEqual(
    fileResourceKeys({ path: 'src\\a.ts' }),
    fileResourceKeys({ path: './src/a.ts' }),
  )
  assert.deepEqual(fileResourceKeys({ path: '../outside' }), [])
  assert.equal(resourcesConflict(['workspace:src'], ['workspace:src/a']), true)
  assert.equal(resourcesConflict([], ['workspace:a']), true)
  assert.equal(resourcesConflict(['workspace:a'], ['workspace:ab']), false)
})

test('only trusted disjoint writes batch; same-file edits, reads and unknown effects form barriers', () => {
  const call = (effect, key, concurrentSafe = false) => ({
    effect,
    resourceKeys: key ? [key] : [],
    concurrentSafe,
  })
  const groups = planBatches([
    call('read', 'a'),
    call('read', 'b'),
    call('write', 'a', true),
    call('write', 'b', true),
    call('write', 'a', true),
    call('shell'),
    call('write', 'c'),
    call('read', 'c'),
  ])
  assert.deepEqual(
    groups.map((group) => group.length),
    [2, 2, 1, 1, 1, 1],
  )
  assert.deepEqual(
    planBatches(Array.from({ length: 19 }, () => call('read'))).map(
      (group) => group.length,
    ),
    [8, 8, 3],
  )
})
