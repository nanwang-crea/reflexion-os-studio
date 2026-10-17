import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { HostBrowserTransport } from '../dist/browser/agent/embedded/host.js'
import { scopedContext } from '../dist/browser/agent/embedded/connection.js'

test('private host responses stay isolated and do not expose untrusted error text', async () => {
  const sent = []
  const host = new HostBrowserTransport((request) => sent.push(request))
  const first = host.request({ kind: 'check', lease: randomUUID() })
  const second = host.request({ kind: 'close', lease: randomUUID() })
  assert.equal(
    host.receive({ jsonrpc: '2.0', id: 'ordinary', result: {} }),
    false,
  )
  host.receive({ jsonrpc: '2.0', id: sent[1].id, result: { closed: true } })
  host.receive({
    jsonrpc: '2.0',
    id: sent[0].id,
    error: { code: -1, message: 'unsafe endpoint details' },
  })
  assert.deepEqual(await second, { closed: true })
  await assert.rejects(first, /browser_operation_failed/)
  const pending = host.request({ kind: 'check', lease: randomUUID() })
  host.dispose()
  await assert.rejects(pending, /browser_closed/)
})

test('control handoff notifications validate identity and unsubscribe', () => {
  const host = new HostBrowserTransport(() => {})
  const changes = []
  const remove = host.onControl((...change) => changes.push(change))
  const lease = randomUUID()
  for (const params of [
    { lease, paused: true },
    { lease: 'invalid', paused: true },
  ])
    assert.equal(
      host.receive({ jsonrpc: '2.0', method: 'host.browser.control', params }),
      true,
    )
  remove()
  host.receive({
    jsonrpc: '2.0',
    method: 'host.browser.control',
    params: { lease, paused: false },
  })
  assert.deepEqual(changes, [[lease, true]])
})

test('MCP context cannot select, route or close sibling pages, including event chaining', async () => {
  let closed = false
  const routed = []
  const page = {
    isClosed: () => closed,
    close: async () => {
      closed = true
    },
    route: (...args) => routed.push(args),
    routeWebSocket: () => {},
    addInitScript: (...args) => routed.push(args),
    once: () => {},
  }
  const context = {
    pages: () => [page, { sibling: true }],
    close: () => assert.fail('must not close shared CEF context'),
  }
  const scoped = scopedContext(context, page)
  assert.deepEqual(scoped.pages(), [page])
  assert.equal(await scoped.newPage(), page)
  assert.equal(
    scoped.on('page', () => {}),
    scoped,
  )
  assert.equal(
    scoped.once('close', () => {}),
    scoped,
  )
  scoped.route('**/*', 'handler')
  assert.deepEqual(routed, [['**/*', 'handler']])
  scoped.addInitScript('page-only')
  assert.deepEqual(routed.at(-1), ['page-only'])
  assert.throws(() => scoped.cookies(), /browser_operation_failed/)
  assert.throws(() => scoped.storageState(), /browser_operation_failed/)
  await scoped.close()
  assert.deepEqual(scoped.pages(), [])
  await assert.rejects(scoped.newPage(), /browser_closed/)
})
