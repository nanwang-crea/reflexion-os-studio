import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEventListeners } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { InteractionGateway } from '../dist/agent/interactions/gateway.js'
import { RunLauncher } from '../dist/agent/launcher.js'
import { ApprovalGateway } from '../dist/agent/permissions/index.js'

const questions = [
  {
    id: 'choice',
    header: '选择',
    question: '继续吗？',
    multiSelect: false,
    options: [
      { id: 'yes', label: '继续', description: '继续任务' },
      { id: 'no', label: '取消', description: '取消任务' },
    ],
  },
]
const answers = [{ questionId: 'choice', selectedOptionIds: ['yes'] }]
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-lifecycle-'))
  const store = new Store(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'fixture',
    model: 'fixture',
  })
  const message = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  const tool = store.toolCalls.create({
    runId: run.id,
    messageId: message.id,
    toolName: 'ask_user',
    args: {},
    status: 'running',
  })
  const gateway = new InteractionGateway(store)
  return { store, session, run, message, tool, gateway }
}
function ask(f, signal, notify = () => {}) {
  return f.gateway.requestQuestions({
    sessionId: f.session.id,
    runId: f.run.id,
    toolCallId: f.tool.id,
    questions,
    signal,
    emitter: new RunEventEmitter(f.run.id, notify),
  })
}
for (const failure of ['resolve', 'run', 'tool']) {
  test(`answer ${failure} write failure preserves the pending promise and retryable persisted state`, async (t) => {
    const f = fixture(t),
      controller = new AbortController()
    const pending = ask(f, controller.signal)
    const interaction = f.gateway.listPending()[0]
    const [owner, method] =
      failure === 'resolve'
        ? [f.store.interactions, 'resolve']
        : failure === 'run'
          ? [f.store.runs, 'setIntermediateStatus']
          : [f.store.toolCalls, 'markStatus']
    const original = owner[method].bind(owner)
    owner[method] = (...args) => {
      original(...args)
      throw Error('fixture database failure')
    }
    assert.throws(
      () => f.gateway.respond(interaction.id, answers),
      /database failure/,
    )
    assert.equal(f.store.interactions.get(interaction.id).status, 'pending')
    assert.equal(f.store.runs.get(f.run.id).status, 'awaiting_user_input')
    assert.equal(f.store.toolCalls.get(f.tool.id).status, 'awaiting_user_input')
    assert.equal(f.gateway.hasPendingRun(f.run.id), true)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
    owner[method] = original
    assert.equal(f.gateway.respond(interaction.id, answers).accepted, true)
    assert.deepEqual(await pending, answers)
    assert.equal(f.gateway.hasPendingRun(f.run.id), false)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
}

test('resolved notification failure cannot strand the accepted answer', async (t) => {
  const f = fixture(t),
    controller = new AbortController()
  const pending = ask(f, controller.signal, (event) => {
    if (event.type === 'interaction.resolved')
      throw Error('fixture notification failure')
  })
  const interaction = f.gateway.listPending()[0]
  assert.equal(f.gateway.respond(interaction.id, answers).accepted, true)
  assert.deepEqual(await pending, answers)
  assert.equal(f.store.interactions.get(interaction.id).status, 'resolved')
  assert.equal(f.store.runs.get(f.run.id).status, 'running')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('required notification failure removes the undelivered question and abort listener', async (t) => {
  const f = fixture(t),
    controller = new AbortController()
  await assert.rejects(
    ask(f, controller.signal, () => {
      throw Error('fixture notification failure')
    }),
    /notification failure/,
  )
  assert.equal(f.gateway.listPending().length, 0)
  assert.equal(f.gateway.hasPendingRun(f.run.id), false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('abort persistence failure still rejects the waiting promise', async (t) => {
  const f = fixture(t),
    controller = new AbortController()
  const pending = ask(f, controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  f.store.interactions.removePending = () => {
    throw Error('fixture database failure')
  }
  controller.abort()
  await rejected
  assert.equal(f.gateway.hasPendingRun(f.run.id), false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

for (const throwCallback of [false, true]) {
  test(`launch setup failures finalize the run and clean resources even if callbacks throw: ${throwCallback}`, async (t) => {
    const f = fixture(t),
      controller = new AbortController()
    let failures = 0,
      releases = 0,
      settled
    const finished = new Promise((resolve) => {
      settled = resolve
    })
    const launcher = new RunLauncher(
      {
        store: f.store,
        system: null,
        mcp: null,
        approvals: new ApprovalGateway(),
        interactions: f.gateway,
        skills: { list: () => [] },
        danger: { isActive: () => false },
        runner: {
          execute: async () =>
            assert.fail('runner must not execute after setup failure'),
        },
        browser: {
          finishRun: () => {
            throw Error('fixture browser cleanup failure')
          },
        },
        skillTools: {
          releaseRun: () => {
            releases++
          },
        },
      },
      {
        onRunSettled: () => {
          settled()
          if (throwCallback) throw Error('fixture settled hook failure')
        },
      },
    )
    f.store.agentSettings.get = () => {
      throw Error('fixture setup failure')
    }
    assert.doesNotThrow(() =>
      launcher.launch({
        run: f.run,
        session: f.session,
        assistantMessage: f.message,
        profile: {},
        apiKey: 'unused',
        model: 'fixture',
        sampling: {},
        skill: null,
        parentSignal: controller.signal,
        emitter: new RunEventEmitter(f.run.id, () => {}),
        onFailure: () => {
          failures++
          if (throwCallback) throw Error('fixture callback failure')
        },
      }),
    )
    await finished
    assert.equal(failures, 1)
    assert.equal(releases, 1)
    assert.equal(f.store.runs.get(f.run.id).status, 'failed')
    assert.equal(f.store.runs.get(f.run.id).errorCode, 'run_setup_failed')
    assert.equal(f.store.messages.get(f.message.id).status, 'failed')
    assert.equal(launcher.cancel(f.run.id), false)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })
}
