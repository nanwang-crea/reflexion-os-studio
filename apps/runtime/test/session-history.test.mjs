import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../dist/store/index.js'
import { dispatchCommand } from '../dist/handlers.js'
import { CommandSchemaRegistry } from '@reflexion-os-studio/contracts'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'history-page-'))
  const store = new Store(dir)
  const db = new DatabaseSync(join(dir, 'reflexion.db'))
  t.after(() => {
    db.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const session = store.sessions.create(null)
  return { store, db, session }
}

function round(store, sessionId, number, steps = 3) {
  const run = store.runs.create({ sessionId, providerId: null, model: null })
  const user = store.messages.create({
    sessionId,
    runId: run.id,
    role: 'user',
    content: `question ${number}`,
    status: 'completed',
  })
  const messages = [user]
  for (let i = 0; i < steps; i++) {
    const message = store.messages.create({
      sessionId,
      runId: run.id,
      role: 'assistant',
      content: `step ${i}`,
      status: 'completed',
    })
    messages.push(message)
    store.toolCalls.create({
      runId: run.id,
      messageId: message.id,
      toolName: 'time',
      args: {},
    })
  }
  messages.push(
    store.messages.create({
      sessionId,
      runId: run.id,
      role: 'assistant',
      content: `answer ${number}`,
      status: 'completed',
    }),
  )
  store.runs.finalize(run.id, 'completed')
  store.runEvents.createFailed({
    sessionId,
    runId: run.id,
    errorCode: 'example',
    errorMessage: 'fixture',
  })
  return { run, user, messages }
}

async function page(store, sessionId, before) {
  const result = await dispatchCommand(
    'session.get',
    { requestId: 'page', sessionId, before },
    { store },
  )
  return CommandSchemaRegistry['session.get'].result.parse(result)
}

test('pages contain ten complete turns, including every tool step, with stable same-millisecond cursors', async (t) => {
  const { store, db, session } = setup(t)
  const rounds = Array.from({ length: 25 }, (_, i) =>
    round(store, session.id, i, i === 24 ? 80 : 3),
  )
  db.exec("UPDATE messages SET created_at = '2026-10-09T00:00:00.000Z'")
  const newest = await page(store, session.id)
  assert.equal(newest.messages.filter((m) => m.role === 'user').length, 10)
  assert.equal(newest.messages[0].id, rounds[15].user.id)
  assert.ok(
    rounds[24].messages.every((message) =>
      newest.messages.some((m) => m.id === message.id),
    ),
  )
  assert.equal(newest.runs.length, 10)
  assert.equal(newest.runEvents.length, 10)
  assert.equal(newest.toolCalls.length, 9 * 3 + 80)
  const middle = await page(store, session.id, newest.nextBefore)
  const oldest = await page(store, session.id, middle.nextBefore)
  assert.equal(middle.messages.filter((m) => m.role === 'user').length, 10)
  assert.equal(oldest.messages.filter((m) => m.role === 'user').length, 5)
  assert.equal(oldest.nextBefore, null)
  const all = [...oldest.messages, ...middle.messages, ...newest.messages]
  assert.deepEqual(
    all.map((m) => m.id),
    store.messages.listBySession(session.id).map((m) => m.id),
  )
  assert.equal(new Set(all.map((m) => m.id)).size, all.length)
})

test('retry belongs to its original user turn and superseded edit rounds do not count', async (t) => {
  const { store, session } = setup(t)
  const rounds = Array.from({ length: 12 }, (_, i) =>
    round(store, session.id, i),
  )
  const original = rounds[11]
  const retry = store.runs.replaceWithRetry(
    original.run.id,
    {
      sessionId: session.id,
      providerId: null,
      model: null,
      skillId: null,
      agentTemplateId: null,
      planId: null,
      planStepId: null,
    },
    store.messages,
  )
  const reply = store.messages.create({
    sessionId: session.id,
    runId: retry.id,
    role: 'assistant',
    content: 'retry answer',
    status: 'completed',
  })
  const history = await page(store, session.id)
  assert.equal(history.messages.filter((m) => m.role === 'user').length, 10)
  assert.ok(history.messages.some((m) => m.id === original.user.id))
  assert.ok(history.messages.some((m) => m.id === reply.id))
  assert.ok(!history.messages.some((m) => m.id === original.messages[1].id))
  store.messages.markSupersededRound(original.run.id)
  store.messages.markSupersededByRun(retry.id)
  const replacement = round(store, session.id, 'edited')
  const edited = await page(store, session.id)
  assert.equal(edited.messages.filter((m) => m.role === 'user').length, 10)
  assert.ok(!edited.messages.some((m) => m.id === original.user.id))
  assert.ok(edited.messages.some((m) => m.id === replacement.user.id))
})

test('empty history, another session and pagination limits stay isolated', async (t) => {
  const { store, session } = setup(t)
  const other = store.sessions.create(null)
  round(store, other.id, 1)
  const empty = await page(store, session.id)
  assert.deepEqual(empty.messages, [])
  assert.deepEqual(empty.runs, [])
  assert.deepEqual(empty.toolCalls, [])
  assert.equal(empty.nextBefore, null)
  assert.equal(
    CommandSchemaRegistry['session.get'].params.safeParse({
      requestId: 'p',
      sessionId: session.id,
      turns: 0,
    }).success,
    false,
  )
  assert.equal(
    CommandSchemaRegistry['session.get'].params.safeParse({
      requestId: 'p',
      sessionId: session.id,
      turns: 51,
    }).success,
    false,
  )
})
