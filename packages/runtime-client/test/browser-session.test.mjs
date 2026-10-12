import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBrowserSessionClient } from '../dist/index.js'
import { DEFAULT_BROWSER_SETTINGS } from '@reflexion-os-studio/contracts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup() {
  const calls = []
  let stored = {
    ...DEFAULT_BROWSER_SETTINGS,
    defaultRoute: 'embedded',
    localRoute: 'system',
  }
  const settings = {
    get: async () => ({ ...stored }),
    update: async (next) => {
      stored = next
      return { ...next }
    },
  }
  const native = {
    capabilities: async () => ({ embeddedAvailable: true }),
    open: async (url) => {
      calls.push(['open', url])
      return { available: true }
    },
    openExternal: async (url) => {
      calls.push(['external', url])
    },
    control: async (action) => {
      calls.push(['control', action.kind])
      return { available: true }
    },
  }
  const client = createBrowserSessionClient(settings, native)
  return { client, settings, native, calls }
}

test('disable waits for an in-flight open; later opens and attaches cannot recreate the session', async () => {
  const { client, native, calls } = setup()
  const started = deferred()
  const release = deferred()
  native.open = async () => {
    calls.push(['open'])
    started.resolve()
    await release.promise
    return { available: true }
  }
  const opening = client.openLink('https://example.com')
  await started.promise
  const disable = client.updateSettings({
    ...DEFAULT_BROWSER_SETTINGS,
    mode: 'system',
  })
  const later = client.openLink('https://example.net')
  const attach = client.attach(() => true)
  release.resolve()
  assert.equal(await opening, true)
  await disable
  assert.equal(await later, false)
  await attach
  assert.deepEqual(calls, [
    ['open'],
    ['control', 'close'],
    ['external', 'https://example.net/'],
    ['control', 'status'],
  ])
  await assert.rejects(client.control({ kind: 'newtab' }), /已关闭/)
})

test('a slow settings read cannot overwrite a completed save', async () => {
  const { client, settings } = setup()
  const started = deferred()
  const release = deferred()
  const original = settings.get
  settings.get = async () => {
    const captured = await original()
    started.resolve()
    await release.promise
    return captured
  }
  const reading = client.getSettings()
  await started.promise
  const next = { ...DEFAULT_BROWSER_SETTINGS, showFullUrl: false }
  const save = client.updateSettings(next)
  release.resolve()
  await reading
  await save
  assert.deepEqual(client.getSnapshot(), next)
})

test('cancelled panel attachment does not create a tab after asynchronous preference loading', async () => {
  const { client, settings, calls } = setup()
  const release = deferred()
  settings.get = () => release.promise
  let active = true
  const attach = client.attach(() => active)
  active = false
  release.resolve(DEFAULT_BROWSER_SETTINGS)
  await attach
  assert.deepEqual(calls, [['control', 'status']])
})

test('failed preference loading falls back to system and does not poison the queue', async () => {
  const { client, settings, calls } = setup()
  settings.get = async () => {
    throw new Error('offline')
  }
  assert.equal(await client.openLink('localhost:3000'), false)
  assert.equal(await client.navigate('example.com'), null)
  await client.control({ kind: 'close' })
  assert.deepEqual(calls, [
    ['external', 'https://localhost:3000/'],
    ['external', 'https://example.com/'],
    ['control', 'close'],
  ])
})

test('invalid settings cannot clear a live session and failed disposal cannot persist disablement', async () => {
  const { client, native, settings, calls } = setup()
  assert.throws(() =>
    client.updateSettings({
      ...DEFAULT_BROWSER_SETTINGS,
      mode: 'system',
      extra: true,
    }),
  )
  assert.equal(calls.length, 0)
  let writes = 0
  settings.update = async () => {
    writes++
    throw new Error('unexpected')
  }
  native.control = async () => {
    throw new Error('dispose failed')
  }
  await assert.rejects(
    client.updateSettings({ ...DEFAULT_BROWSER_SETTINGS, mode: 'system' }),
    /dispose failed/,
  )
  assert.equal(writes, 0)
  assert.equal(client.getSnapshot().mode, 'embedded')
})

test('unavailable adapter and local links use system; malformed links never reach the adapter', async () => {
  const { client, native, calls } = setup()
  assert.equal(await client.openLink('http://127.2.3.4:3000'), false)
  native.capabilities = async () => ({ embeddedAvailable: false })
  assert.equal(await client.openLink('https://example.com'), false)
  assert.throws(() => client.openLink('javascript:alert(1)'))
  assert.deepEqual(calls, [
    ['external', 'http://127.2.3.4:3000/'],
    ['external', 'https://example.com/'],
  ])
})

test('native profile configuration completes before navigation and rolls back on failed save', async () => {
  const { client, native, settings } = setup()
  const actions = []
  native.capabilities = async () => ({
    embeddedAvailable: true,
    features: { persistentSession: true },
  })
  native.control = async (action) => {
    actions.push(action)
    return { available: true }
  }
  await client.navigate('example.com')
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['configure', 'navigate'],
  )
  settings.update = async () => {
    throw new Error('synthetic storage failure')
  }
  await assert.rejects(
    client.updateSettings({
      ...client.getSnapshot(),
      storageMode: 'persistent',
    }),
    /storage failure/,
  )
  assert.deepEqual(
    actions.slice(-2).map((a) => a.storageMode),
    ['persistent', 'temporary'],
  )
  assert.equal(client.getSnapshot().storageMode, 'temporary')
})

test('unsupported persistent profiles never create a native session', async () => {
  const { client, native, settings, calls } = setup()
  native.capabilities = async () => ({
    embeddedAvailable: true,
    features: { persistentSession: false },
  })
  settings.get = async () => ({
    ...DEFAULT_BROWSER_SETTINGS,
    storageMode: 'persistent',
  })
  await assert.rejects(
    client.attach(() => true),
    /不支持/,
  )
  assert.equal(calls.length, 0)
})
