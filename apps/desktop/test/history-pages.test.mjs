import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const compiled = await build({
  stdin: {
    contents: `export * from './frontend/hooks/session/history-pages.ts'; export * from './frontend/features/chat/transcript/virtual-layout.ts'`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  format: 'esm',
  write: false,
})
const {
  mergeLatestHistory,
  prependHistory,
  buildOffsets,
  visibleRange,
  indexAt,
} = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
)
const position = (rowId) => ({ createdAt: '2026-10-09T00:00:00.000Z', rowId })
function page(start, end, more = true) {
  const messages = Array.from({ length: end - start + 1 }, (_, index) => ({
    id: String(index + start),
    runId: `r${index + start}`,
  }))
  return {
    session: { id: 's' },
    messages,
    positions: Object.fromEntries(
      messages.map((m) => [m.id, position(Number(m.id))]),
    ),
    nextBefore: more ? position(start) : null,
    runs: messages.map((m) => ({ id: m.runId })),
    toolCalls: messages.map((m) => ({
      id: `t${m.id}`,
      messageId: m.id,
      runId: m.runId,
    })),
    runEvents: messages.map((m) => ({ id: `e${m.id}`, runId: m.runId })),
    plans: [],
  }
}

test('prepend deduplicates all projections and preserves newer values', () => {
  const current = page(11, 20)
  current.messages[0].content = 'fresh'
  const combined = prependHistory(current, page(1, 11, false))
  assert.equal(combined.messages.length, 20)
  assert.equal(combined.messages[10].content, 'fresh')
  assert.equal(combined.toolCalls.length, 20)
  assert.equal(combined.runs.length, 20)
  assert.equal(combined.runEvents.length, 20)
  assert.equal(combined.nextBefore, null)
})

test('refresh preserves older history but removes superseded tail and projections', () => {
  const current = page(1, 20, false)
  const latest = page(11, 21)
  latest.messages = latest.messages.filter((m) => m.id !== '20')
  delete latest.positions['20']
  latest.runs = latest.runs.filter((r) => r.id !== 'r20')
  latest.toolCalls = latest.toolCalls.filter((c) => c.messageId !== '20')
  latest.runEvents = latest.runEvents.filter((e) => e.runId !== 'r20')
  const combined = mergeLatestHistory(current, latest)
  assert.equal(combined.messages[0].id, '1')
  assert.equal(combined.messages.at(-1).id, '21')
  assert.equal(combined.messages.length, 20)
  assert.equal(combined.nextBefore, null)
  assert.ok(!combined.messages.some((m) => m.id === '20'))
  assert.ok(!combined.toolCalls.some((c) => c.messageId === '20'))
  assert.ok(!combined.runs.some((r) => r.id === 'r20'))
  assert.ok(!combined.runEvents.some((e) => e.runId === 'r20'))
})

test('a missing overlap or another session resets to latest instead of leaving gaps', () => {
  const latest = page(30, 40)
  assert.equal(mergeLatestHistory(page(1, 10), latest), latest)
  const other = { ...page(1, 40), session: { id: 'other' } }
  assert.equal(mergeLatestHistory(other, latest), latest)
  assert.equal(
    mergeLatestHistory(page(1, 40), page(31, 40, false)).messages.length,
    10,
  )
})

test('a long transcript mounts a bounded window and uses measured dynamic heights', () => {
  const keys = Array.from({ length: 10000 }, (_, index) => String(index))
  const heights = new Map([
    ['4999', 1500],
    ['5000', 70],
  ])
  const offsets = buildOffsets(keys, heights)
  const [start, end] = visibleRange(offsets, offsets[5000], 800)
  assert.ok(end - start < 20)
  assert.ok(start <= 5000 && end > 5000)
  assert.equal(indexAt(offsets, offsets[5000] + 69), 5000)
  assert.equal(indexAt(offsets, offsets[5000] + 70), 5001)
  const [first, last] = visibleRange(offsets, offsets.at(-1) - 800, 800)
  assert.ok(last - first < 20)
  assert.equal(last, 10000)
  assert.deepEqual(visibleRange([0], 0, 800), [0, 0])
})
