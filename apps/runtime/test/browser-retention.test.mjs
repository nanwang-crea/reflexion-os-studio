import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { BrowserAgentService } from '../dist/browser/agent/service.js'

function fixture(t, lifetime = 'session') {
  const workers = []
  const removedSessions = new Set()
  const settings = { agentBrowserEnabled: true, agentBrowserLifetime: lifetime }
  const browser = new BrowserAgentService(
    {
      browserSettings: { get: () => settings },
      sessions: { get: (id) => (removedSessions.has(id) ? null : { id }) },
    },
    () => {
      const worker = { disposed: false, connects: 0, page: null }
      workers.push(worker)
      return {
        connect: async () => {
          worker.connects++
        },
        disposeAndWait: async () => {
          worker.disposed = true
        },
        callTool: async (operation) => {
          if (operation === 'navigate')
            worker.page = {
              tabId: randomUUID(),
              origin: 'https://example.com',
              pageVersion: randomUUID(),
            }
          return JSON.stringify({
            page: worker.page,
            sourceUrl: 'https://example.com/',
            title: 'Public page',
            truncated: false,
            injectionWarning: false,
            ...(operation === 'read'
              ? { snapshot: '- heading "Public page"' }
              : {}),
          })
        },
      }
    },
  )
  t.after(() => browser.shutdown())
  const signal = new AbortController().signal
  const navigate = (sessionId, runId) =>
    browser.call(
      sessionId,
      runId,
      'navigate',
      { url: 'https://example.com/' },
      signal,
    )
  const read = (sessionId, runId, page) =>
    browser.call(sessionId, runId, 'read', page, signal)
  return { browser, workers, settings, navigate, read, signal, removedSessions }
}

test('completed replies retain their browser and only the same session can resume with approved page identity', async (t) => {
  const f = fixture(t)
  const first = await f.navigate('chat', 'run1')
  f.browser.finishRun('run1')
  assert.equal(f.workers[0].disposed, false)
  await assert.rejects(
    f.read('other-chat', 'other-run', first.page),
    /browser_page_stale/,
  )
  const continued = await f.read('chat', 'run2', first.page)
  assert.match(continued.snapshot, /Public page/)
  assert.equal(f.workers.length, 1)
  assert.equal(f.workers[0].connects, 1)
  f.browser.finishRun('run2')
  await f.navigate('chat', 'run3')
  assert.equal(f.workers.length, 1)
  await assert.rejects(f.read('chat', 'run3', first.page), /browser_page_stale/)
})

for (const [lifetime, cancelled] of [
  ['run', false],
  ['session', true],
]) {
  test(`${lifetime} mode, cancelled=${cancelled}: terminal cleanup closes the browser`, async (t) => {
    const f = fixture(t, lifetime)
    await f.navigate('chat', 'run1')
    f.browser.finishRun('run1', cancelled)
    assert.equal(f.workers[0].disposed, true)
    await f.navigate('chat', 'run2')
    assert.equal(f.workers.length, 2)
  })
}

test('session removal releases its retained browser without closing another conversation', async (t) => {
  const f = fixture(t)
  await f.navigate('chat1', 'run1')
  await f.navigate('chat2', 'run2')
  f.browser.finishRun('run1')
  f.browser.finishRun('run2')
  f.browser.releaseSession('chat1')
  assert.equal(f.workers[0].disposed, true)
  assert.equal(f.workers[1].disposed, false)
  await f.browser.closeAll()
  assert.equal(f.workers[1].disposed, true)
  await f.browser.closeAll()
})

test('retained browsers count toward capacity; explicit close-all releases capacity and invalidates old identities', async (t) => {
  const f = fixture(t)
  let first
  for (let index = 0; index < 8; ++index) {
    const page = await f.navigate(`chat${index}`, `run${index}`)
    first ??= page
    f.browser.finishRun(`run${index}`)
  }
  await assert.rejects(f.navigate('chat9', 'run9'), /browser_capacity/)
  // Reusing an existing session works even at capacity.
  await f.read('chat0', 'resume', first.page)
  await f.browser.closeAll()
  assert.ok(f.workers.every((worker) => worker.disposed))
  await assert.rejects(
    f.read('chat0', 'next', first.page),
    /browser_page_stale/,
  )
  await f.navigate('chat9', 'run9')
  assert.equal(f.workers.length, 9)
})

test('retained workers are revoked and shutdown waits for disposal', async (t) => {
  const f = fixture(t)
  const first = await f.navigate('chat', 'run1')
  f.browser.finishRun('run1')
  f.browser.revoke()
  assert.equal(f.workers[0].disposed, true)
  await assert.rejects(f.read('chat', 'run2', first.page), /browser_page_stale/)
  await f.navigate('chat', 'run2')
  f.browser.finishRun('run2')
  await f.browser.shutdown()
  assert.ok(f.workers.every((worker) => worker.disposed))
})

test('cascaded child-session deletion also releases retained browser workers', async (t) => {
  const f = fixture(t)
  await f.navigate('root', 'root-run')
  await f.navigate('child', 'child-run')
  f.browser.finishRun('root-run')
  f.browser.finishRun('child-run')
  f.removedSessions.add('root')
  f.removedSessions.add('child')
  f.browser.releaseSession('root')
  assert.ok(f.workers.every((worker) => worker.disposed))
})
