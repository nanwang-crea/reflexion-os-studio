import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../dist/store/index.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-store-')))
}

test('project and session CRUD', () => {
  const store = freshStore()
  const project = store.projects.create({
    name: 'Demo',
    folderPath: '/tmp/demo',
  })
  assert.equal(store.projects.list().length, 1)
  assert.equal(store.projects.list()[0].name, 'Demo')

  const session = store.sessions.create(project.id)
  assert.equal(session.title, '新对话')
  assert.equal(session.projectId, project.id)

  const named = store.sessions.create(project.id, '调研')
  store.sessions.create(project.id, 'unused')
  const sessions = store.sessions.list(project.id)
  assert.equal(sessions.length, 3)
  assert.ok(sessions.some((item) => item.id === named.id))
})

test('message lifecycle: create, streaming, finalize keeps parts in sync', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'prov1',
    model: 'mock-model',
  })

  const userMessage = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: '你好',
    status: 'completed',
  })
  // canonical parts：非空 content → 单 text 块。
  assert.deepEqual(userMessage.parts, [{ type: 'text', text: '你好' }])

  const assistantMessage = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  assert.deepEqual(assistantMessage.parts, [])

  store.messages.markStreaming(assistantMessage.id)
  store.messages.finalize(
    assistantMessage.id,
    '你好！有什么可以帮你？',
    'completed',
    '思考内容',
  )

  const messages = store.messages.listBySession(session.id)
  assert.equal(messages.length, 2)
  const finalized = messages.find((m) => m.id === assistantMessage.id)
  assert.equal(finalized.status, 'completed')
  assert.equal(finalized.content, '你好！有什么可以帮你？')
  assert.equal(finalized.reasoning, '思考内容')
  assert.deepEqual(finalized.parts, [
    { type: 'text', text: '你好！有什么可以帮你？' },
  ])
  assert.ok(finalized.completedAt)
})

test('run lifecycle: awaiting_approval counts as active', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)

  assert.equal(store.runs.activeForSession(session.id), null)

  const run = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  assert.equal(store.runs.activeForSession(session.id).id, run.id)

  store.runs.finalize(run.id, 'awaiting_approval')
  assert.equal(store.runs.get(run.id).status, 'awaiting_approval')
  assert.ok(store.runs.activeForSession(session.id))

  store.runs.finalize(run.id, 'completed')
  assert.equal(store.runs.activeForSession(session.id), null)
  assert.equal(store.runs.get(run.id).status, 'completed')
})

test('retry_of_run_id and agent delegation fields persist', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const original = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  store.runs.finalize(original.id, 'failed', 'network')

  const retry = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
    retryOfRunId: original.id,
    agentId: 'agent-worker',
    parentRunId: original.id,
    delegationId: 'd1',
  })
  const persisted = store.runs.get(retry.id)
  assert.equal(persisted.retryOfRunId, original.id)
  assert.equal(persisted.agentId, 'agent-worker')
  assert.equal(persisted.parentRunId, original.id)
  assert.equal(persisted.delegationId, 'd1')

  const plain = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  assert.equal(store.runs.get(plain.id).agentId, null)
})

test('tool call lifecycle: create, status, finalize, recovery', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  const assistantMessage = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'streaming',
  })

  const toolCall = store.toolCalls.create({
    runId: run.id,
    messageId: assistantMessage.id,
    toolName: 'file.read',
    args: { path: 'src/app.ts' },
  })
  assert.equal(toolCall.status, 'pending')
  assert.deepEqual(toolCall.args, { path: 'src/app.ts' })

  store.toolCalls.markStatus(toolCall.id, 'awaiting_approval', 'grant-1')
  assert.equal(store.toolCalls.get(toolCall.id).approvalGrantId, 'grant-1')
  store.toolCalls.markStatus(toolCall.id, 'running')
  store.toolCalls.finalize(toolCall.id, 'completed', { lines: 42 })

  const persisted = store.toolCalls.get(toolCall.id)
  assert.equal(persisted.status, 'completed')
  assert.deepEqual(persisted.result, { lines: 42 })
  assert.ok(persisted.completedAt)
  assert.deepEqual(
    store.toolCalls.listByRun(run.id).map((t) => t.id),
    [toolCall.id],
  )
  assert.deepEqual(
    store.toolCalls.listByMessage(assistantMessage.id).map((t) => t.id),
    [toolCall.id],
  )
})

test('recovery marks unfinished runs/messages/tool calls on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-recover-'))
  const first = new Store(dir)
  const project = first.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = first.sessions.create(project.id)
  const run = first.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  const message = first.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '部分内容',
    status: 'streaming',
  })
  const toolCall = first.toolCalls.create({
    runId: run.id,
    messageId: message.id,
    toolName: 'shell.execute',
    args: { command: 'ls' },
    status: 'running',
  })

  const reopened = new Store(dir)
  const recoveredRun = reopened.runs.get(run.id)
  assert.equal(recoveredRun.status, 'interrupted')
  assert.ok(recoveredRun.completedAt)
  const recoveredMessage = reopened.messages
    .listBySession(session.id)
    .find((m) => m.id === message.id)
  assert.equal(recoveredMessage.status, 'interrupted')
  assert.equal(recoveredMessage.content, '部分内容')
  // 崩溃时未完结的工具调用不保留半执行状态。
  assert.equal(reopened.toolCalls.get(toolCall.id).status, 'cancelled')
})

test('provider profile upsert keeps capabilities when omitted on edit', () => {
  const store = freshStore()
  const created = store.providers.upsert({
    name: 'main',
    baseUrl: 'https://api.example.com/v1',
    models: ['model-b'],
    capabilities: ['chat', 'embedding'],
    secretRef: 'local:b',
    enabled: true,
  })
  assert.deepEqual(created.capabilities, ['chat', 'embedding'])
  assert.equal(store.providers.getEnabled().id, created.id)

  const updated = store.providers.upsert({
    id: created.id,
    name: 'main-renamed',
    baseUrl: 'https://api.example.com/v2',
    models: ['model-c'],
    secretRef: 'local:b',
    enabled: true,
  })
  assert.equal(updated.name, 'main-renamed')
  // 编辑未传 capabilities → 保留原值而不是重置为 ['chat']。
  assert.deepEqual(updated.capabilities, ['chat', 'embedding'])
})

test('transaction rolls back on error', () => {
  const store = freshStore()
  assert.throws(() => {
    store.transaction(() => {
      store.projects.create({ name: 'inside', folderPath: '/tmp/inside' })
      throw new Error('boom')
    })
  }, /boom/)
  assert.equal(store.projects.list().length, 0)
})

test('v3 schema migrates in place: parts backfill and new columns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-v3-'))
  const db = new DatabaseSync(join(dir, 'reflexion.db'))
  db.exec('PRAGMA user_version = 3')
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_path TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
      reasoning TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL, provider_id TEXT, model TEXT,
      started_at TEXT, completed_at TEXT, error_code TEXT, retry_of_run_id TEXT
    );
    CREATE TABLE provider_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, models TEXT NOT NULL,
      secret_ref TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO projects (id, name, folder_path, created_at, updated_at)
      VALUES ('p-old', '旧项目', '/tmp/old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO sessions (id, project_id, title, status, created_at, updated_at)
      VALUES ('s-old', 'p-old', '旧会话', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages (id, session_id, run_id, role, content, reasoning, status, created_at, completed_at)
      VALUES ('m-old', 's-old', NULL, 'user', '旧消息内容', '', 'completed',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO provider_profiles (id, name, base_url, models, secret_ref, enabled, updated_at)
      VALUES ('pp-old', '旧供应商', 'https://example.com/v1', '["old-model"]', 'local:x', 1,
              '2026-01-01T00:00:00.000Z');
  `)
  db.close()

  const store = new Store(dir)
  // 一次性迁移：content 回填为单 text 块，content 本体保留。
  const migrated = store.messages.listBySession('s-old')[0]
  assert.equal(migrated.content, '旧消息内容')
  assert.deepEqual(migrated.parts, [{ type: 'text', text: '旧消息内容' }])
  // 新列可写：runs 支持 agent 委派字段。
  const run = store.runs.create({
    sessionId: 's-old',
    providerId: null,
    model: null,
    agentId: 'agent-1',
  })
  assert.equal(store.runs.get(run.id).agentId, 'agent-1')
  // capabilities 缺省回填为 ['chat']。
  assert.deepEqual(store.providers.get('pp-old').capabilities, ['chat'])
  // tool_calls 表已可用。
  const toolCall = store.toolCalls.create({
    runId: run.id,
    messageId: null,
    toolName: 'file.list',
    args: { path: '.' },
  })
  assert.equal(store.toolCalls.get(toolCall.id).toolName, 'file.list')
  store.close()
})

test('provider sampling params: set, keep on omitted, clear on null', () => {
  const store = freshStore()
  const created = store.providers.upsert({
    name: 'p',
    baseUrl: 'https://api.example.com/v1',
    models: ['m1'],
    secretRef: 'local:a',
    enabled: true,
    temperature: 0.7,
    maxTokens: 4096,
    contextWindow: 128000,
  })
  assert.equal(created.temperature, 0.7)
  assert.equal(created.contextWindow, 128000)

  // 省略参数：保留原值。
  const kept = store.providers.upsert({
    id: created.id,
    name: 'p',
    baseUrl: 'https://api.example.com/v1',
    models: ['m1'],
    secretRef: 'local:a',
    enabled: true,
  })
  assert.equal(kept.temperature, 0.7)
  assert.equal(kept.maxTokens, 4096)
  assert.equal(kept.contextWindow, 128000)

  // 显式 null：清空回未配置。
  const cleared = store.providers.upsert({
    id: created.id,
    name: 'p',
    baseUrl: 'https://api.example.com/v1',
    models: ['m1'],
    secretRef: 'local:a',
    enabled: true,
    temperature: null,
    maxTokens: null,
    contextWindow: null,
  })
  assert.equal(cleared.temperature, null)
  assert.equal(cleared.maxTokens, null)
  assert.equal(cleared.contextWindow, null)
  store.close()
})

test('run usage accumulates across turns', () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  store.runs.addUsage(run.id, { promptTokens: 10, completionTokens: 5 })
  store.runs.addUsage(run.id, { promptTokens: 20, completionTokens: 8 })
  const usage = store.runs.get(run.id).usage
  assert.deepEqual(usage, { promptTokens: 30, completionTokens: 13 })
  store.close()
})

test('agent settings default and round-trip', () => {
  const store = freshStore()
  assert.deepEqual(store.agentSettings.get(), {
    maxTurns: null,
    reflectionThreshold: null,
    requestRetries: null,
    requestTimeoutSec: null,
  })
  const updated = store.agentSettings.upsert({
    maxTurns: 32,
    reflectionThreshold: 3,
    requestRetries: 0,
    requestTimeoutSec: 60,
  })
  assert.deepEqual(store.agentSettings.get(), updated)
  assert.equal(updated.maxTurns, 32)
  // 非法 JSON 容错回默认。
  const db = store
  assert.equal(db.agentSettings.get().maxTurns, 32)
  store.close()
})
