import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-store-')))
}

test('project and session CRUD', () => {
  const store = freshStore()
  const project = store.createProject('Demo')
  assert.equal(store.listProjects().length, 1)
  assert.equal(store.listProjects()[0].name, 'Demo')

  const session = store.createSession(project.id)
  assert.equal(session.title, '新会话')
  assert.equal(session.projectId, project.id)

  const named = store.createSession(project.id, '调研')
  store.createSession(project.id, 'unused')
  const sessions = store.listSessions(project.id)
  assert.equal(sessions.length, 3)
  assert.ok(sessions.some((item) => item.id === named.id))
})

test('message lifecycle: create, streaming, finalize', () => {
  const store = freshStore()
  const project = store.createProject('p')
  const session = store.createSession(project.id)
  const run = store.createRun({
    sessionId: session.id,
    providerId: 'prov1',
    model: 'mock-model',
  })

  const userMessage = store.createMessage({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: '你好',
    status: 'completed',
  })
  const assistantMessage = store.createMessage({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })

  store.setMessageStreaming(assistantMessage.id)
  store.finalizeMessage(
    assistantMessage.id,
    '你好！有什么可以帮你？',
    'completed',
  )

  const messages = store.getSessionMessages(session.id)
  assert.equal(messages.length, 2)
  const finalized = messages.find((m) => m.id === assistantMessage.id)
  assert.equal(finalized.status, 'completed')
  assert.equal(finalized.content, '你好！有什么可以帮你？')
  assert.ok(finalized.completedAt)
  assert.ok(messages.find((m) => m.id === userMessage.id))
})

test('activeRunForSession reflects run state', () => {
  const store = freshStore()
  const project = store.createProject('p')
  const session = store.createSession(project.id)

  assert.equal(store.activeRunForSession(session.id), null)

  const run = store.createRun({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  assert.equal(store.activeRunForSession(session.id).id, run.id)

  store.finalizeRun(run.id, 'completed')
  assert.equal(store.activeRunForSession(session.id), null)
  assert.equal(store.getRun(run.id).status, 'completed')
})

test('retry_of_run_id is persisted', () => {
  const store = freshStore()
  const project = store.createProject('p')
  const session = store.createSession(project.id)
  const original = store.createRun({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  store.finalizeRun(original.id, 'failed', 'network')

  const retry = store.createRun({
    sessionId: session.id,
    providerId: null,
    model: null,
    retryOfRunId: original.id,
  })
  assert.equal(store.getRun(retry.id).retryOfRunId, original.id)
})

test('recovery marks unfinished runs and messages interrupted on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-recover-'))
  const first = new Store(dir)
  const project = first.createProject('p')
  const session = first.createSession(project.id)
  const run = first.createRun({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  const message = first.createMessage({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '部分内容',
    status: 'streaming',
  })

  const reopened = new Store(dir)
  const recoveredRun = reopened.getRun(run.id)
  assert.equal(recoveredRun.status, 'interrupted')
  assert.ok(recoveredRun.completedAt)
  const recoveredMessage = reopened
    .getSessionMessages(session.id)
    .find((m) => m.id === message.id)
  assert.equal(recoveredMessage.status, 'interrupted')
  assert.equal(recoveredMessage.content, '部分内容')
})

test('enabled provider profile lookup and upsert', () => {
  const store = freshStore()
  const disabled = store.upsertProviderProfile({
    name: 'backup',
    baseUrl: 'https://api.example.com/v1',
    model: 'model-a',
    secretRef: 'local:a',
    enabled: false,
  })
  assert.equal(store.getEnabledProviderProfile(), null)

  const enabled = store.upsertProviderProfile({
    name: 'main',
    baseUrl: 'https://api.example.com/v1',
    model: 'model-b',
    secretRef: 'local:b',
    enabled: true,
  })
  assert.equal(store.getEnabledProviderProfile().id, enabled.id)

  const updated = store.upsertProviderProfile({
    id: enabled.id,
    name: 'main-renamed',
    baseUrl: 'https://api.example.com/v2',
    model: 'model-c',
    secretRef: 'local:b',
    enabled: true,
  })
  assert.equal(updated.name, 'main-renamed')
  assert.equal(updated.id, enabled.id)
  assert.equal(store.listProviderProfiles().length, 2)
  assert.equal(
    store.getEnabledProviderProfile().id,
    disabled.id === enabled.id ? '' : enabled.id,
  )
})

test('transaction rolls back on error', () => {
  const store = freshStore()
  assert.throws(() => {
    store.transaction(() => {
      store.createProject('inside')
      throw new Error('boom')
    })
  }, /boom/)
  assert.equal(store.listProjects().length, 0)
})
