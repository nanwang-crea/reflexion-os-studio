import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBrowserSurfaceClient } from '../dist/index.js'

const snapshot = {
  tabs: [],
  activeTabId: null,
  available: true,
  status: 'idle',
  progress: 0,
  url: null,
  canGoBack: false,
  canGoForward: false,
  revision: 1,
  notice: null,
}
function harness() {
  const calls = []
  let receive
  let cleanup = false
  const client = createBrowserSurfaceClient({
    invoke: async (command, args) => {
      calls.push([command, args])
      return snapshot
    },
    listen: async (name, handler) => {
      assert.equal(name, 'browser:state')
      receive = handler
      return () => {
        cleanup = true
      }
    },
  })
  return {
    client,
    calls,
    emit: (payload) => receive({ payload }),
    cleaned: () => cleanup,
  }
}

test('normalizes navigation through Host only and rejects unsafe input before dispatch', async () => {
  const { client, calls } = harness()
  await client.open('localhost:3000')
  await client.control({ kind: 'navigate', url: 'http://intranet/' })
  await client.openExternal('http://example.com')
  assert.deepEqual(
    calls.map(([command]) => command),
    ['browser_open', 'browser_control', 'open_external'],
  )
  assert.equal(calls[0][1].url, 'https://localhost:3000/')
  assert.equal(calls[1][1].action.url, 'http://intranet/')
  await assert.rejects(client.open('file:///tmp/a'))
  await assert.rejects(client.control({ kind: 'evaluate', script: '1+1' }))
  assert.equal(calls.length, 3)
})

test('validates event envelopes and unsubscribes', async () => {
  const h = harness()
  const received = []
  const cleanup = await h.client.subscribe((value) => received.push(value))
  h.emit({ status: 'ready' })
  h.emit({ ...snapshot, revision: -1 })
  h.emit(snapshot)
  assert.deepEqual(received, [snapshot])
  cleanup()
  assert.equal(h.cleaned(), true)
})

test('rejects a malformed Host response instead of assuming browsing is safe', async () => {
  const client = createBrowserSurfaceClient({
    invoke: async () => ({ available: true }),
    listen: async () => () => {},
  })
  await assert.rejects(client.open())
})

test('new tabs normalize URLs and reject file protocols before dispatch', async () => {
  const { client, calls } = harness()
  await client.control({ kind: 'newtab', url: 'example.test' })
  assert.equal(calls[0][1].action.url, 'https://example.test/')
  await assert.rejects(client.control({ kind: 'newtab', url: 'file:///tmp/x' }))
  assert.equal(calls.length, 1)
})
