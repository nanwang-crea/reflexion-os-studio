import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { harness, http, paired } from './helpers.mjs'
import { RemotePairing } from '../../dist/access/remote/auth/pairing.js'
import { RuntimeEventBus } from '../../dist/access/events.js'
import { RemoteLiveState } from '../../dist/access/remote/state/live-state.js'
import { RuntimeRequestGateway } from '../../dist/access/requests/gateway.js'
import { remoteHistory } from '../../dist/access/remote/state/projection.js'

const rpc = (method, params = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params: { requestId: crypto.randomUUID(), ...params },
})

test('invitations are short lived and single use; approval/revocation/expiry gate credentials', () => {
  let now = Date.now()
  const pairing = new RemotePairing(() => now)
  const expired = pairing.invite()
  now += 120001
  assert.throws(() => pairing.pair(expired.invitation, 'phone'))
  const invitation = pairing.invite()
  const { credential, device } = pairing.pair(invitation.invitation, 'phone')
  assert.throws(() => pairing.pair(invitation.invitation, 'phone'))
  assert.throws(() => pairing.authenticate(credential))
  assert.equal(pairing.authenticate(credential, false).approved, false)
  assert.equal(pairing.resolve(device.id, true), true)
  assert.equal(pairing.resolve(device.id, true), false)
  assert.equal(pairing.authenticate(credential).approved, true)
  assert.equal(JSON.stringify(pairing.list()).includes(credential), false)
  now += 8 * 3600_000 + 1
  assert.throws(() => pairing.authenticate(credential))
})

test('one event client failing cannot prevent other deliveries', () => {
  let delivered = 0
  let failed = 0
  const bus = new RuntimeEventBus(() => failed++)
  bus.subscribe(() => {
    throw Error('disconnected')
  })
  const unsubscribe = bus.subscribe(() => delivered++)
  bus.publish({})
  unsubscribe()
  bus.publish({})
  assert.equal(delivered, 1)
  assert.equal(failed, 2)
})

test('gateway applies common schema, isolates device operation identities and retains desktop errors', async () => {
  const calls = []
  const gateway = new RuntimeRequestGateway({
    authorize: () => {},
    report: () => {},
    dispatch: async (method, params) => {
      calls.push({ method, params })
      return {}
    },
  })
  assert.equal(
    (await gateway.execute(rpc('missing'), { kind: 'desktop' })).error.code,
    -32601,
  )
  assert.equal(
    (await gateway.execute(rpc('message.send'), { kind: 'desktop' })).error
      .code,
    -32602,
  )
  await gateway.execute(
    rpc('message.send', {
      sessionId: 'session',
      content: 'hello',
      requestId: 'same',
    }),
    {
      kind: 'device',
      deviceId: 'phone',
      accessScope: 'all_sessions',
    },
  )
  assert.equal(calls[0].params.requestId, 'device:phone:same')
})

test('HTTPS serving and pairing reject wrong Host/Origin, pending devices, and unsupported commands', async (t) => {
  const h = await harness(t)
  assert.equal((await http(h.status.origin, '')).status, 200)
  assert.equal((await http(h.status.origin, 'assets/app-test.js')).status, 200)
  for (const path of [
    '.env',
    '../package.json',
    'index.html',
    'assets/../../AGENTS.md',
  ])
    assert.equal((await http(h.status.origin, path)).status, 404)
  assert.equal(
    (await http(h.status.origin, '', { origin: 'https://evil.example' }))
      .status,
    403,
  )
  assert.equal(
    (await http(h.status.origin, '', { host: 'rebind.example' })).status,
    403,
  )
  assert.equal(
    (
      await http(h.status.origin, 'api/rpc', {
        body: rpc('session.get', { sessionId: h.session.id }),
      })
    ).status,
    403,
  )
  const invitation = new URLSearchParams(
    new URL(h.status.invitationUrl).hash.slice(1),
  ).get('invitation')
  const pending = await http(h.status.origin, 'api/pair', {
    body: { invitation, name: 'phone' },
  })
  const cookie = pending.headers['set-cookie'][0].split(';')[0]
  assert.match(
    pending.headers['set-cookie'][0],
    /HttpOnly; Secure; SameSite=Strict/,
  )
  assert.equal(
    (
      await http(h.status.origin, 'api/rpc', {
        cookie,
        body: rpc('session.get', { sessionId: h.session.id }),
      })
    ).status,
    403,
  )
  h.service.resolve(pending.json.device.id, true)
  const own = await http(h.status.origin, 'api/rpc', {
    cookie,
    body: rpc('session.get', { sessionId: h.session.id }),
  })
  assert.equal(own.json.result.session.id, h.session.id)
  const otherSession = await http(h.status.origin, 'api/rpc', {
    cookie,
    body: rpc('session.get', { sessionId: h.other.id }),
  })
  assert.equal(otherSession.json.result.session.id, h.other.id)
  const allSessions = await http(h.status.origin, 'api/rpc', {
    cookie,
    body: rpc('session.list', {}),
  })
  assert.ok(
    allSessions.json.result.sessions.some((item) => item.id === h.other.id),
  )
  for (const [method, params] of [
    ['provider.list', {}],
    ['project.list', {}],
    ['remote.stop', {}],
    ['asset.read', { assetId: 'unknown' }],
    ['approval.resolve', { toolCallId: 'foreign', choiceId: 'yes' }],
  ]) {
    const denied = await http(h.status.origin, 'api/rpc', {
      cookie,
      body: rpc(method, params),
    })
    assert.ok(denied.json.error, method)
  }
  assert.equal(h.service.revoke(pending.json.device.id), true)
  assert.equal(
    (await http(h.status.origin, 'api/pair', { cookie })).status,
    403,
  )
})

test('SSE snapshot restores live deltas and pending approvals then delivers only authorized events; revoke ends stream', async (t) => {
  const h = await harness(t)
  const { cookie, device } = await paired(h)
  h.bus.publish(
    h.event('message.delta', {
      messageId: h.message.id,
      chunkSeq: 0,
      delta: 'before ',
    }),
  )
  h.bus.publish(
    h.event('message.delta', {
      messageId: h.message.id,
      chunkSeq: 1,
      delta: 'connect',
    }),
  )
  h.bus.publish(
    h.event('approval.required', {
      toolCallId: 'call',
      operation: 'file.edit',
      summary: 'approve',
      sessionId: h.session.id,
    }),
  )
  const packets = []
  let ended
  const end = new Promise((resolve) => {
    ended = resolve
  })
  const ready = new Promise((resolve, reject) => {
    const eventsUrl = new URL('api/events', h.status.origin)
    eventsUrl.searchParams.set('sessionId', h.session.id)
    const req = httpsRequest(
      eventsUrl,
      { rejectUnauthorized: false, headers: { Cookie: cookie } },
      (res) => {
        let buffer = ''
        res.on('data', (chunk) => {
          buffer += chunk
          let index
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            if (frame.startsWith('data: '))
              packets.push(JSON.parse(frame.slice(6)))
          }
          if (packets.length) resolve()
        })
        res.on('end', ended)
      },
    )
    req.once('error', reject)
    req.end()
    t.after(() => req.destroy())
  })
  await ready
  assert.equal(packets[0].type, 'snapshot')
  assert.equal(
    packets[0].events.find((event) => event.type === 'message.delta').delta,
    'before connect',
  )
  assert.ok(
    packets[0].events.some((event) => event.type === 'approval.required'),
  )
  h.bus.publish(
    h.event('message.delta', {
      messageId: h.message.id,
      chunkSeq: 2,
      delta: ' after',
    }),
  )
  h.bus.publish(
    h.event('message.delta', {
      runId: 'foreign-run',
      messageId: 'foreign',
      chunkSeq: 0,
      delta: 'private',
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(packets.at(-1).event.delta, ' after')
  assert.equal(JSON.stringify(packets).includes('private'), false)
  h.service.revoke(device.id)
  await end
})

test('live-state cache bounds drafts, never returns a partial overflowed answer, and clears terminal state', () => {
  const live = new RemoteLiveState()
  const event = (delta) => ({
    scope: 'run',
    type: 'message.delta',
    runId: 'r',
    messageId: 'm',
    delta,
  })
  live.accept(event('a'))
  live.accept(event('b'))
  assert.equal(live.snapshot(() => true).events[0].delta, 'ab')
  live.accept(event('x'.repeat(5 * 1024 * 1024)))
  assert.equal(live.snapshot(() => true).incomplete, true)
  assert.equal(live.snapshot(() => true).events.length, 0)
  live.accept({
    scope: 'run',
    type: 'approval.required',
    runId: 'r',
    toolCallId: 'pending',
    summary: 'fixture',
  })
  assert.equal(live.snapshot(() => true).events[0].toolCallId, 'pending')
  live.accept({ scope: 'run', type: 'run.completed', runId: 'r' })
  assert.equal(live.snapshot(() => true).incomplete, false)
})

test('remote history excludes opaque provider state and diagnostics', () => {
  const history = {
    messages: [
      {
        id: 'm',
        content: 'visible',
        providerContinuation: { opaque: 'fixture-internal' },
        requestAttempts: [{ internal: true }],
      },
    ],
  }
  const projected = remoteHistory(history)
  assert.equal(projected.messages[0].providerContinuation, undefined)
  assert.equal(projected.messages[0].requestAttempts, undefined)
  assert.equal(
    history.messages[0].providerContinuation.opaque,
    'fixture-internal',
  )
})

test('endpoint providers can publish a path-prefixed public address without changing pairing or Runtime', async (t) => {
  let listener
  let closed = false
  const provider = {
    async open(_address, handler) {
      listener = handler
      return {
        baseUrl: 'https://relay.example/devices/desktop/',
        fingerprint: null,
        close: async () => {
          closed = true
        },
      }
    },
  }
  const h = await harness(t, undefined, provider)
  assert.match(
    h.status.invitationUrl,
    /^https:\/\/relay.example\/devices\/desktop\/#invitation=/,
  )
  const server = createServer(listener)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const statusCode = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/devices/desktop/',
        headers: { Host: 'relay.example' },
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      },
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(statusCode, 200)
  await h.service.stop()
  assert.equal(closed, true)
})

test('same device retry is idempotent and cannot collide with another device or desktop receipt', async (t) => {
  const h = await harness(t)
  const principal = {
    kind: 'device',
    deviceId: 'first-phone',
    accessScope: 'all_sessions',
  }
  const request = rpc('message.send', {
    requestId: 'same',
    sessionId: h.session.id,
    content: 'once',
  })
  const responses = await Promise.all([
    h.gateway.execute(request, principal),
    h.gateway.execute(request, principal),
  ])
  assert.ok(responses.every((response) => response.result))
  assert.equal(h.executions.length, 1)
  const changed = await h.gateway.execute(
    rpc('message.send', { ...request.params, content: 'changed' }),
    principal,
  )
  assert.ok(changed.error)
  await h.gateway.execute(request, { ...principal, deviceId: 'second-phone' })
  await h.gateway.execute(request, { kind: 'desktop' })
  assert.equal(h.executions.length, 3)
  const own = await h.gateway.execute(
    rpc('operation.get', { method: 'message.send', targetRequestId: 'same' }),
    principal,
  )
  assert.equal(own.result.operation.phase, 'succeeded')
  assert.equal(own.result.operation.requestId, 'same')
  const absent = await h.gateway.execute(
    rpc('operation.get', { method: 'message.send', targetRequestId: 'same' }),
    { ...principal, deviceId: 'third-phone' },
  )
  assert.equal(absent.result.operation, null)
  assert.equal(
    (await h.gateway.execute(rpc('constructor'), { kind: 'desktop' })).error
      .code,
    -32601,
  )
})

test('desktop and phone resolving the same approval settles it exactly once', async (t) => {
  const h = await harness(t)
  const { ApprovalGateway, buildApprovalChoices } =
    await import('../../dist/agent/permissions/index.js')
  const gateway = new ApprovalGateway()
  const tool = h.store.toolCalls.create({
    runId: h.run.id,
    messageId: h.message.id,
    toolName: 'file.edit',
    args: {},
  })
  const subject = {
    kind: 'workspace-path',
    operation: 'file.edit',
    path: 'example.txt',
  }
  const scope = { sessionId: h.session.id, workspaceRoot: h.directory }
  const choices = buildApprovalChoices({
    toolName: 'file.edit',
    subject,
    sandbox: 'workspace-write',
    network: false,
    escalation: false,
    scope,
  })
  const pending = gateway.request({
    toolCallId: tool.id,
    emitter: { runId: h.run.id, next: () => {} },
    operation: 'file.edit',
    summary: 'fixture approval',
    subject,
    risk: 'normal',
    context: {},
    choices,
    signal: new AbortController().signal,
    scope,
  })
  const requestGateway = new RuntimeRequestGateway({
    authorize: (principal) =>
      assert.ok(
        principal.kind === 'desktop' || principal.sessionId === h.session.id,
      ),
    report: () => {},
    dispatch: (method, params) =>
      import('../../dist/handlers.js').then(({ dispatchCommand }) =>
        dispatchCommand(method, params, { approvals: gateway }),
      ),
  })
  const request = rpc('approval.resolve', {
    toolCallId: tool.id,
    choiceId: choices[0].choice.id,
  })
  const responses = await Promise.all([
    requestGateway.execute(request, { kind: 'desktop' }),
    requestGateway.execute(request, {
      kind: 'device',
      deviceId: 'phone',
      sessionId: h.session.id,
    }),
  ])
  assert.equal(
    responses.filter((response) => response.result.accepted).length,
    1,
  )
  assert.equal((await pending).choiceId, choices[0].choice.id)
})

test('stop during endpoint startup closes the eventual endpoint instead of reopening access', async (t) => {
  let release
  let opened = 0
  let closed = 0
  const provider = {
    async open() {
      if (++opened > 1)
        await new Promise((resolve) => {
          release = resolve
        })
      return {
        baseUrl: 'https://relay.example/desktop/',
        fingerprint: null,
        close: async () => {
          closed++
        },
      }
    },
  }
  const h = await harness(t, undefined, provider)
  await h.service.stop()
  const starting = h.service.start('127.0.0.1')
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
  await h.service.stop()
  release()
  await assert.rejects(starting)
  assert.equal(h.service.status().running, false)
  assert.equal(closed, 2)
})

test('stream connection limits preserve existing tabs, and slow clients detach without blocking the bus', async () => {
  const { EventEmitter } = await import('node:events')
  const { RemoteStreams } =
    await import('../../dist/access/remote/transport/streams.js')
  const pairing = new RemotePairing()
  const { invitation } = pairing.invite()
  const { credential, device } = pairing.pair(invitation, 'fixture')
  pairing.resolve(device.id, true)
  const bus = new RuntimeEventBus()
  const streams = new RemoteStreams(bus, { eventBelongs: () => true }, pairing)
  class Response extends EventEmitter {
    writableLength = 0
    writes = 0
    ended = false
    destroyed = false
    writeHead(status) {
      this.status = status
    }
    write() {
      this.writes++
      return true
    }
    end() {
      this.ended = true
      this.emit('close')
    }
    destroy() {
      this.destroyed = true
    }
  }
  const snapshot = () => ({
    type: 'snapshot',
    history: {},
    events: [],
    incomplete: false,
  })
  const first = new Response()
  const second = new Response()
  const third = new Response()
  streams.open(first, credential, 'session', snapshot)
  streams.open(second, credential, 'session', snapshot)
  streams.open(third, credential, 'session', snapshot)
  assert.equal(first.ended, false)
  assert.equal(second.ended, false)
  assert.equal(third.status, 429)
  first.writableLength = 17 * 1024 * 1024
  bus.publish({
    type: 'session.updated',
    scope: 'session',
    sessionId: 'session',
  })
  assert.equal(first.destroyed, true)
  const writes = first.writes
  bus.publish({
    type: 'session.updated',
    scope: 'session',
    sessionId: 'session',
  })
  assert.equal(first.writes, writes)
  assert.equal(second.ended, false)
  streams.close()
})
