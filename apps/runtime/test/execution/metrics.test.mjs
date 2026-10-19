import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RunMetrics } from '../../dist/agent/run/performance/metrics.js'
import { Store } from '../../dist/store/index.js'
import { fixture } from './fixture.mjs'

test('metrics persist only numeric diagnostics, count each physical attempt once, and survive reload', async (t) => {
  const f = fixture(t)
  const metrics = new RunMetrics(null, (value) =>
    f.store.runs.setPerformance(f.run.id, value),
  )
  metrics.add('modelCalls')
  const attempt = {
    id: 'request',
    status: 'completed',
    attempt: 2,
    firstDataMs: 23,
  }
  metrics.attempt(attempt)
  metrics.attempt(attempt)
  await assert.rejects(
    metrics.measure('approvalWaitMs', async () => {
      throw new Error('denied')
    }),
  )
  metrics.add('toolExecutionMs', 10)
  const value = f.store.runs.get(f.run.id).performance
  assert.equal(value.requestAttempts, 1)
  assert.equal(value.requestRetries, 1)
  assert.equal(value.firstDataSamples, 1)
  assert.equal(value.firstDataWaitMs, 23)
  assert.equal(value.toolExecutionMs, 10)
  assert.ok(value.approvalWaitMs >= 0)
  for (const field of Object.values(value)) assert.equal(typeof field, 'number')
  const resumed = new RunMetrics(value)
  assert.ok(resumed.snapshot().elapsedMs >= value.elapsedMs)
})

test('v51 Run data migrates additively and historical performance remains unknown', (t) => {
  const f = fixture(t)
  f.store.db.exec('ALTER TABLE runs DROP COLUMN performance_json')
  f.store.db.exec('PRAGMA user_version = 51')
  // Open a second connection to exercise the normal startup migration without
  // changing any old Run or tool output payload.
  const migrated = new Store(f.workspaceRoot)
  try {
    assert.equal(migrated.runs.get(f.run.id).performance, null)
    assert.equal(migrated.runs.get(f.run.id).id, f.run.id)
  } finally {
    migrated.close()
  }
})
