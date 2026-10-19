import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ensureCheckpoint,
  sanitizeSummary,
  computeSourceHash,
  CHECKPOINT_SCHEMA_VERSION,
  CHECKPOINT_FAILURE_COOLDOWN_MS,
} from '../../dist/agent/context/context-checkpoint.js'
import { SUMMARY, memoryCheckpoint } from './checkpoint-fixtures.mjs'

for (const raw of [
  { wrong: 'shape' },
  { ...SUMMARY, goal: null },
  { ...SUMMARY, goal: 'api_key: discarded' },
]) {
  test('invalid, empty and secret-only summaries never commit a success cache', async () => {
    const fixture = memoryCheckpoint(`invalid-${JSON.stringify(raw)}`)
    const result = await ensureCheckpoint({
      ...fixture.options(),
      store: fixture.store,
      summarize: async () => raw,
    })
    assert.equal(result.failed, true)
    assert.equal(result.summarized, false)
    assert.equal(fixture.row, null)
    assert.equal(fixture.commits, 0)
    assert.throws(() => sanitizeSummary(raw))
  })
}

test('invalid refresh preserves a usable earlier summary and retries after a bounded cooldown', async (t) => {
  const fixture = memoryCheckpoint('cooldown-recovery')
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  await ensureCheckpoint({ ...fixture.options(), store: fixture.store })
  const saved = fixture.row
  let calls = 0
  const refresh = {
    ...fixture.options(),
    store: fixture.store,
    stableFrames: [{ kind: 'user', content: 'source extended' }],
    summarize: async () => {
      calls++
      return calls === 1 ? { invalid: true } : { ...SUMMARY, goal: 'recovered' }
    },
  }
  assert.equal((await ensureCheckpoint(refresh)).failed, true)
  assert.equal(fixture.row, saved)
  assert.equal((await ensureCheckpoint(refresh)).failed, true)
  assert.equal(calls, 1)
  now += CHECKPOINT_FAILURE_COOLDOWN_MS + 1
  assert.equal((await ensureCheckpoint(refresh)).failed, false)
  assert.equal(calls, 2)
  assert.equal(fixture.row.summary.goal, 'recovered')
})

test('cancelled summary cannot commit or poison the next attempt', async () => {
  const fixture = memoryCheckpoint('cancel-recovery')
  const controller = new AbortController()
  await assert.rejects(
    ensureCheckpoint({
      ...fixture.options(),
      store: fixture.store,
      signal: controller.signal,
      summarize: async () => {
        controller.abort()
        return SUMMARY
      },
    }),
    { name: 'AbortError' },
  )
  assert.equal(fixture.commits, 0)
  assert.equal(
    (await ensureCheckpoint({ ...fixture.options(), store: fixture.store }))
      .failed,
    false,
  )
})

test('empty successful cache from an earlier implementation is rebuilt instead of reused', async () => {
  const fixture = memoryCheckpoint('empty-success-cache')
  const options = { ...fixture.options(), store: fixture.store }
  fixture.store.contextCheckpoints.upsert({
    sourceHash: computeSourceHash(options.stableFrames),
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    summary: { ...SUMMARY, goal: null },
    throughMessageId: 'm1',
  })
  let calls = 0
  const result = await ensureCheckpoint({
    ...options,
    summarize: async () => {
      calls++
      return SUMMARY
    },
  })
  assert.equal(result.hit, false)
  assert.equal(calls, 1)
  assert.equal(fixture.row.summary.goal, SUMMARY.goal)
})

test('v1 summaries are invalidated and image references participate in source identity', async () => {
  assert.equal(CHECKPOINT_SCHEMA_VERSION, 2)
  const fixture = memoryCheckpoint('old-version')
  const options = { ...fixture.options(), store: fixture.store }
  fixture.store.contextCheckpoints.upsert({
    sourceHash: computeSourceHash(options.stableFrames, 1),
    schemaVersion: 1,
    summary: SUMMARY,
    throughMessageId: 'm1',
  })
  let previous = 'not-called'
  await ensureCheckpoint({
    ...options,
    summarize: async (input) => {
      previous = input.previousSummary
      return SUMMARY
    },
  })
  assert.equal(previous, null)
  assert.equal(fixture.row.schemaVersion, 2)
  const frame = {
    kind: 'user',
    content: 'inspect image',
    images: [{ type: 'image', assetId: 'image-a', mimeType: 'image/png' }],
  }
  assert.notEqual(
    computeSourceHash([frame]),
    computeSourceHash([
      { ...frame, images: [{ ...frame.images[0], assetId: 'image-b' }] },
    ]),
  )
})

test('transport-local abort is a failed refresh when the parent run is still active', async () => {
  const fixture = memoryCheckpoint('local-transport-abort')
  const result = await ensureCheckpoint({
    ...fixture.options(),
    store: fixture.store,
    summarize: async () => {
      throw new DOMException('request timed out', 'AbortError')
    },
  })
  assert.equal(result.failed, true)
  assert.equal(fixture.commits, 0)
})
