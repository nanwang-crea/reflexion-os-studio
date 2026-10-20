import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { saveSecret } from '../dist/secrets.js'
import { ChatAgent } from '../dist/agent/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { RunFinalizer } from '../dist/agent/run/run-finalizer.js'
import { createRunExecutionState } from '../dist/agent/run/run-state.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-admission-'))
  const store = new Store(dir)
  const events = [],
    launches = []
  const agent = new ChatAgent(store, (event) => events.push(event), null)
  agent.launch = (input) => launches.push(input)
  const profile = store.providers.upsert({
    name: 'fixture',
    baseUrl: 'https://example.invalid',
    models: ['fixture'],
    enabled: true,
    secretRef: saveSecret('synthetic-admission-fixture'),
  })
  const session = store.sessions.create(null)
  t.after(() => {
    agent.dispose()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, agent, profile, session, events, launches }
}

for (const failure of ['user', 'assistant', 'rename', 'touch']) {
  test(`send admission rolls back run, messages and title if ${failure} persistence fails`, (t) => {
    const f = fixture(t)
    let restore
    if (failure === 'user' || failure === 'assistant') {
      const create = f.store.messages.create.bind(f.store.messages)
      f.store.messages.create = (input) => {
        const message = create(input)
        if (input.role === failure) throw Error('fixture persistence failure')
        return message
      }
      restore = () => {
        f.store.messages.create = create
      }
    } else {
      const original = f.store.sessions[failure].bind(f.store.sessions)
      f.store.sessions[failure] = (...args) => {
        original(...args)
        throw Error('fixture persistence failure')
      }
      restore = () => {
        f.store.sessions[failure] = original
      }
    }
    const params = {
      requestId: 'send',
      sessionId: f.session.id,
      content: 'Keep this message',
      providerId: f.profile.id,
    }
    assert.throws(() => f.agent.startSend(params), /persistence failure/)
    assert.equal(f.store.runs.listBySession(f.session.id).length, 0)
    assert.equal(f.store.messages.listBySession(f.session.id).length, 0)
    assert.equal(f.store.sessions.get(f.session.id).title, f.session.title)
    assert.equal(f.events.length, 0)
    assert.equal(f.launches.length, 0)
    restore()
    f.agent.markSessionTitleManuallyEdited(f.session.id)
    f.agent.startSend(params)
    assert.equal(f.store.messages.listBySession(f.session.id).length, 2)
    assert.equal(f.launches.length, 1)
  })
}

test('queued config failure retains FIFO contents and pauses until explicit retry succeeds', (t) => {
  const f = fixture(t)
  f.store.sessions.rename(f.session.id, 'Named')
  const active = f.store.runs.create({
    sessionId: f.session.id,
    providerId: f.profile.id,
    model: 'fixture',
  })
  const first = f.agent.send({
    requestId: 'first',
    sessionId: f.session.id,
    content: 'first',
    providerId: f.profile.id,
  })
  f.agent.send({
    requestId: 'second',
    sessionId: f.session.id,
    content: 'second',
    providerId: f.profile.id,
  })
  f.store.runs.finalize(active.id, 'completed')
  f.store.providers.upsert({ ...f.profile, enabled: false })
  f.agent.sendNow(f.session.id, first.queueId)
  let queue = f.agent.listQueue(f.session.id)
  assert.equal(queue.paused, true)
  assert.deepEqual(
    queue.items.map((item) => item.content),
    ['first', 'second'],
  )
  assert.equal(f.store.messages.listBySession(f.session.id).length, 0)
  assert.equal(f.launches.length, 0)
  f.store.providers.upsert({ ...f.profile, enabled: true })
  f.agent.resumeQueue(f.session.id)
  queue = f.agent.listQueue(f.session.id)
  assert.equal(queue.paused, false)
  assert.deepEqual(
    queue.items.map((item) => item.content),
    ['second'],
  )
  assert.equal(f.store.messages.listBySession(f.session.id)[0].content, 'first')
  assert.equal(f.launches.length, 1)
})

test('post-admission failures cannot restore and replay an already persisted queued message', (t) => {
  const f = fixture(t)
  f.store.sessions.rename(f.session.id, 'Named')
  const active = f.store.runs.create({
    sessionId: f.session.id,
    providerId: f.profile.id,
    model: 'fixture',
  })
  const queued = f.agent.send({
    requestId: 'first',
    sessionId: f.session.id,
    content: 'accepted',
    providerId: f.profile.id,
  })
  f.store.runs.finalize(active.id, 'completed')
  f.agent.launch = () => {
    throw Error('fixture launch failed after admission')
  }
  f.agent.sendNow(f.session.id, queued.queueId)
  assert.equal(f.agent.listQueue(f.session.id).items.length, 0)
  assert.equal(
    f.store.messages
      .listBySession(f.session.id)
      .filter((m) => m.role === 'user').length,
    1,
  )
})

for (const status of ['cancelled', 'failed']) {
  test(`finalizer ${status} applies explicit pending payload only to its message id`, (t) => {
    const f = fixture(t)
    const run = f.store.runs.create({
      sessionId: f.session.id,
      providerId: f.profile.id,
      model: 'fixture',
    })
    const earlier = f.store.messages.create({
      sessionId: f.session.id,
      runId: run.id,
      role: 'assistant',
      content: 'earlier draft',
      status: 'pending',
    })
    const current = f.store.messages.create({
      sessionId: f.session.id,
      runId: run.id,
      role: 'assistant',
      content: 'current draft',
      status: 'pending',
    })
    const state = createRunExecutionState()
    state.turn = {
      id: current.id,
      content: 'current memory',
      reasoning: 'current thought',
    }
    new RunFinalizer(f.store).finalize(
      { run, state, emitter: new RunEventEmitter(run.id, () => {}) },
      {
        status,
        errorCode: status === 'failed' ? 'fixture_failure' : null,
        errorMessage: null,
        pendingMessage: {
          messageId: current.id,
          content: 'final current',
          reasoning: 'final thought',
          parts: [{ type: 'text', text: 'final current' }],
        },
      },
    )
    const messages = f.store.messages.listBySession(f.session.id)
    assert.equal(
      messages.find((m) => m.id === earlier.id).content,
      'earlier draft',
    )
    assert.deepEqual(messages.find((m) => m.id === earlier.id).parts, [
      { type: 'text', text: 'earlier draft' },
    ])
    assert.equal(
      messages.find((m) => m.id === current.id).content,
      'final current',
    )
    assert.equal(
      messages.find((m) => m.id === current.id).reasoning,
      'final thought',
    )
    assert.ok(
      messages.every(
        (m) => m.status === (status === 'failed' ? 'failed' : 'interrupted'),
      ),
    )
  })
}

for (const method of ['retry', 'edit-resend']) {
  for (const failure of ['assistant', 'touch']) {
    test(`${method} rollback preserves the visible original round on ${failure} failure`, (t) => {
      const f = fixture(t)
      const original = f.store.runs.create({
        sessionId: f.session.id,
        providerId: f.profile.id,
        model: 'fixture',
      })
      const user = f.store.messages.create({
        sessionId: f.session.id,
        runId: original.id,
        role: 'user',
        content: 'original user',
        status: 'completed',
      })
      f.store.messages.create({
        sessionId: f.session.id,
        runId: original.id,
        role: 'assistant',
        content: 'original answer',
        status: 'failed',
      })
      f.store.runs.finalize(original.id, 'failed')
      const before = f.store.messages.listBySession(f.session.id)
      let restore
      if (failure === 'assistant') {
        const create = f.store.messages.create.bind(f.store.messages)
        f.store.messages.create = (input) => {
          const row = create(input)
          if (input.role === 'assistant')
            throw Error('fixture persistence failure')
          return row
        }
        restore = () => {
          f.store.messages.create = create
        }
      } else {
        const touch = f.store.sessions.touch.bind(f.store.sessions)
        f.store.sessions.touch = (...args) => {
          touch(...args)
          throw Error('fixture persistence failure')
        }
        restore = () => {
          f.store.sessions.touch = touch
        }
      }
      const invoke = () =>
        method === 'retry'
          ? f.agent.startRetry({ requestId: 'retry', runId: original.id })
          : f.agent.startEditResend({
              requestId: 'edit',
              sessionId: f.session.id,
              messageId: user.id,
              content: 'edited',
            })
      assert.throws(invoke, /persistence failure/)
      assert.deepEqual(f.store.messages.listBySession(f.session.id), before)
      assert.equal(f.store.runs.listBySession(f.session.id).length, 1)
      assert.equal(f.store.runs.get(original.id).supersededByRunId, null)
      assert.equal(f.launches.length, 0)
      assert.equal(f.events.length, 0)
      restore()
      invoke()
      assert.equal(f.launches.length, 1)
    })
  }
}
