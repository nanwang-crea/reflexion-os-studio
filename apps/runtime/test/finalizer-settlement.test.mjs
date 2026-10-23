import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { RunRunner } from '../dist/agent/run/runner.js'
import { RunFinalizer } from '../dist/agent/run/run-finalizer.js'
import { createRunExecutionState } from '../dist/agent/run/run-state.js'

function freshStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'finalizer-settlement-'))
  const store = new Store(directory)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return store
}

function harness(t, notify = () => {}) {
  const store = freshStore(t)
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  const draft = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: 'saved',
    status: 'pending',
  })
  const state = createRunExecutionState()
  state.turn = { id: draft.id, content: 'streamed', reasoning: 'reasoning' }
  return {
    store,
    run,
    draft,
    state,
    emitter: new RunEventEmitter(run.id, notify),
  }
}

for (const status of ['completed', 'failed', 'cancelled']) {
  for (const throwNotifier of [false, true]) {
    test(`double commit failure settles ${status} as failure once, notifier throws: ${throwNotifier}`, (t) => {
      const events = []
      const h = harness(t, (event) => {
        events.push(event)
        if (throwNotifier) throw new Error('notifier failed')
      })
      let attempts = 0
      const finalizeRun = h.store.runs.finalize.bind(h.store.runs)
      h.store.runs.finalize = (...args) => {
        finalizeRun(...args)
        attempts++
        throw new Error('database commit failed')
      }
      const outcomes = []
      const context = {
        ...h,
        onResult: () => outcomes.push('completed'),
        onCancel: () => outcomes.push('cancelled'),
        onFailure: (error) => outcomes.push(error.message),
      }
      const decision = {
        status,
        errorCode: null,
        errorMessage: null,
        pendingMessage: null,
      }
      const finalizer = new RunFinalizer(h.store)
      assert.doesNotThrow(() => finalizer.finalize(context, decision))
      finalizer.finalize(context, decision)
      assert.equal(attempts, 2)
      assert.equal(outcomes.length, 1)
      assert.match(outcomes[0], /终态保存失败/)
      assert.deepEqual(
        events.map((event) => event.type),
        ['run.failed'],
      )
      assert.equal(events[0].error.code, 'run_finalization_failed')
      assert.equal(h.store.runs.get(h.run.id).status, h.run.status)
      assert.equal(h.store.messages.get(h.draft.id).status, 'pending')
      assert.equal(h.store.messages.get(h.draft.id).content, 'saved')
      assert.equal(h.state.turn.content, 'streamed')
    })
  }
}

test('a transient transaction failure retries the same draft then clears state', (t) => {
  const h = harness(t)
  let attempts = 0
  const finalizeRun = h.store.runs.finalize.bind(h.store.runs)
  h.store.runs.finalize = (...args) => {
    finalizeRun(...args)
    if (++attempts === 1) throw new Error('transient failure')
  }
  let results = 0
  new RunFinalizer(h.store).finalize(
    { ...h, onResult: () => results++ },
    {
      status: 'completed',
      errorCode: null,
      errorMessage: null,
      pendingMessage: null,
      resultContent: 'done',
    },
  )
  assert.equal(attempts, 2)
  assert.equal(results, 1)
  assert.equal(h.state.turn, null)
  assert.equal(h.store.messages.get(h.draft.id).content, 'streamed')
  assert.equal(h.store.runs.get(h.run.id).status, 'completed')
})

test('a throwing callback cannot trigger another commit or terminal callback', (t) => {
  const events = []
  const h = harness(t, (event) => events.push(event))
  let results = 0
  const finalizer = new RunFinalizer(h.store)
  const context = {
    ...h,
    onResult: () => {
      results++
      throw new Error('callback failed')
    },
  }
  const decision = {
    status: 'completed',
    errorCode: null,
    errorMessage: null,
    pendingMessage: null,
  }
  assert.doesNotThrow(() => finalizer.finalize(context, decision))
  finalizer.finalize(context, { ...decision, status: 'failed' })
  assert.equal(results, 1)
  assert.deepEqual(
    events.map((event) => event.type),
    ['run.completed'],
  )
  assert.equal(h.store.runs.get(h.run.id).status, 'completed')
})

test('one failed tool notification does not suppress remaining tool and Run events', (t) => {
  const events = []
  const h = harness(t, (event) => {
    events.push(event)
    if (events.length === 1) throw new Error('first tool notification failed')
  })
  for (let i = 0; i < 2; i++) {
    const call = h.store.toolCalls.create({
      runId: h.run.id,
      messageId: h.draft.id,
      toolName: 'get_current_time',
      args: {},
      status: 'pending',
    })
    h.state.toolCallRowIds.add(call.id)
  }
  let failures = 0
  new RunFinalizer(h.store).finalize(
    { ...h, onFailure: () => failures++ },
    {
      status: 'failed',
      errorCode: 'internal',
      errorMessage: 'failed',
      pendingMessage: null,
    },
  )
  assert.equal(failures, 1)
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool.completed', 'tool.completed', 'run.failed'],
  )
  assert.equal(h.store.runs.get(h.run.id).status, 'failed')
  assert.ok(
    h.store.toolCalls
      .listByRun(h.run.id)
      .every((call) => call.status === 'cancelled'),
  )
})

test('finalizer settles callbacks exactly once even when notifier throws', async (t) => {
  const store = freshStore(t)
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: 'hello',
    status: 'completed',
  })
  const firstAssistant = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  // 通知器抛错：事件发送失败不得吞掉回调。
  const throwingEmitter = new RunEventEmitter(run.id, () => {
    throw new Error('notifier exploded')
  })
  let results = 0
  const runner = new RunRunner(store)
  const finalizer = new RunFinalizer(store)
  // 直接调用 finalize 模拟 completed 决策。
  finalizer.finalize(
    {
      run,
      state: {
        turn: null,
        toolCallRowIds: new Set(),
        lastAssistantMessageId: firstAssistant.id,
      },
      emitter: throwingEmitter,
      provider: { baseUrl: 'http://localhost:1', apiKey: 'k', model: 'm' },
      onResult: () => {
        results += 1
      },
    },
    {
      status: 'completed',
      errorCode: null,
      errorMessage: null,
      pendingMessage: null,
      resultContent: 'ok',
    },
  )
  assert.equal(results, 1)
  assert.equal(store.runs.get(run.id).status, 'completed')
  void runner
})

test('failed run persists terminal state and emits run.failed', (t) => {
  const store = freshStore(t)
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const events = []
  new RunFinalizer(store).finalize(
    {
      run,
      state: {
        turn: null,
        toolCallRowIds: new Set(),
        lastAssistantMessageId: null,
      },
      emitter: new RunEventEmitter(run.id, (e) => events.push(e)),
      provider: { baseUrl: 'http://localhost:1', apiKey: 'k', model: 'm' },
      onFailure: () => {},
    },
    {
      status: 'failed',
      errorCode: 'max_turns',
      errorMessage: '任务在 4 轮内未完成，已停止执行',
      pendingMessage: null,
    },
  )
  assert.equal(store.runs.get(run.id).status, 'failed')
  assert.equal(store.runs.get(run.id).errorCode, 'max_turns')
  assert.equal(
    events.some((e) => e.type === 'run.failed'),
    true,
  )
  // ea4f1a4 之后计划不再随 Run 终态收敛，仅由 manage_plan 驱动。
})

test('cancelled run keeps plan untouched and draft to interrupted', (t) => {
  const store = freshStore(t)
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const draft = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '写到一半',
    status: 'pending',
  })
  let cancels = 0
  new RunFinalizer(store).finalize(
    {
      run,
      state: {
        turn: { id: draft.id, content: '写到一半', reasoning: '' },
        toolCallRowIds: new Set(),
        lastAssistantMessageId: draft.id,
      },
      emitter: new RunEventEmitter(run.id, () => {}),
      provider: { baseUrl: 'http://localhost:1', apiKey: 'k', model: 'm' },
      onCancel: () => {
        cancels += 1
      },
    },
    {
      status: 'cancelled',
      errorCode: null,
      errorMessage: null,
      pendingMessage: null,
    },
  )
  // 计划不随 Run 终态收敛（ea4f1a4）：Finalizer 不触碰任何计划行。
  assert.equal(store.runs.get(run.id).status, 'cancelled')
  assert.equal(
    store.messages.listBySession(session.id).find((m) => m.id === draft.id)
      .status,
    'interrupted',
  )
  assert.equal(cancels, 1)
})
