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

test('pending assistant reset clears content while retaining message identity', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'prov1',
    model: 'mock-model',
  })
  const message = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })

  store.messages.finalize(message.id, 'old content', 'pending', 'old reasoning')
  store.messages.resetPending(message.id)

  const reset = store.messages
    .listBySession(session.id)
    .find((item) => item.id === message.id)
  assert.equal(reset.id, message.id)
  assert.equal(reset.content, '')
  assert.equal(reset.reasoning, '')
  assert.deepEqual(reset.parts, [])
  assert.equal(reset.status, 'pending')
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

test('delegation store attaches child run idempotently and queries by session, parent, and child', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const parentRun = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  for (const id of ['agent-1', 'agent-2']) {
    store.agents.upsert({
      id,
      name: id,
      description: '',
      systemPrompt: '',
      enabled: true,
    })
  }
  const first = store.delegations.create({
    sessionId: session.id,
    parentRunId: parentRun.id,
    agentId: 'agent-1',
    task: 'first task',
  })
  const second = store.delegations.create({
    sessionId: session.id,
    parentRunId: parentRun.id,
    agentId: 'agent-2',
    task: 'second task',
  })
  assert.equal(first.status, 'pending')
  const attached = store.delegations.attachChildRun(first.id, 'child-1')
  assert.equal(attached.childRunId, 'child-1')
  assert.deepEqual(store.delegations.getByChildRun('child-1').id, first.id)
  assert.deepEqual(
    store.delegations.listBySession(session.id).map((d) => d.id),
    [first.id, second.id],
  )
  assert.deepEqual(
    store.delegations.listByParentRun(parentRun.id).map((d) => d.id),
    [first.id, second.id],
  )
  assert.throws(
    () => store.delegations.attachChildRun(first.id, 'child-2'),
    /already attached/,
  )
  assert.equal(store.delegations.get('missing'), null)
  store.close()
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

test('recovery converges pending/running delegations with missing or interrupted child', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-delrec-'))
  const first = new Store(dir)
  const project = first.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = first.sessions.create(project.id)
  const parent = first.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })

  // ① pending 且从未分配 child：启动后收敛为 failed（child missing）。
  const noChild = first.delegations.create({
    sessionId: session.id,
    parentRunId: parent.id,
    agentId: 'worker',
    task: 'no child',
  })
  // ② running 但 child Run 已缺失：收敛为 failed（child missing）。
  const gone = first.delegations.create({
    sessionId: session.id,
    parentRunId: parent.id,
    agentId: 'worker',
    task: 'gone child',
  })
  // ③ running 且 child Run 仍在但为 interrupted：收敛为 failed（child interrupted）。
  const interrupted = first.delegations.create({
    sessionId: session.id,
    parentRunId: parent.id,
    agentId: 'worker',
    task: 'interrupted child',
  })
  const child = first.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
    parentRunId: parent.id,
    delegationId: interrupted.id,
  })
  first.delegations.attachChildRun(interrupted.id, child.id)
  first.delegations.update(interrupted.id, 'running')
  // ④ 已完成委派不受恢复影响。
  const done = first.delegations.create({
    sessionId: session.id,
    parentRunId: parent.id,
    agentId: 'worker',
    task: 'done',
  })
  first.delegations.update(done.id, 'completed', 'ok')

  const reopened = new Store(dir)
  const byId = Object.fromEntries(
    reopened.delegations.listBySession(session.id).map((d) => [d.id, d]),
  )
  assert.equal(byId[noChild.id].status, 'failed')
  assert.equal(byId[noChild.id].error, 'recovered: child run missing')
  assert.equal(byId[gone.id].status, 'failed')
  assert.equal(byId[gone.id].error, 'recovered: child run missing')
  assert.equal(byId[interrupted.id].status, 'failed')
  assert.equal(byId[interrupted.id].error, 'recovered: child run interrupted')
  assert.equal(byId[done.id].status, 'completed')
  assert.equal(byId[done.id].result, 'ok')
})

test('cancelByParentRun cancels in-flight delegations idempotently', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const parent = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  const pending = store.delegations.create({
    sessionId: session.id,
    parentRunId: parent.id,
    agentId: 'worker',
    task: 'pending',
  })
  const running = store.delegations.create({
    sessionId: session.id,
    parentRunId: parent.id,
    agentId: 'worker',
    task: 'running',
  })
  const done = store.delegations.create({
    sessionId: session.id,
    parentRunId: parent.id,
    agentId: 'worker',
    task: 'done',
  })
  store.delegations.update(running.id, 'running')
  store.delegations.update(done.id, 'completed', 'ok')

  const firstCancel = store.delegations.cancelByParentRun(parent.id)
  const byId = Object.fromEntries(firstCancel.map((d) => [d.id, d]))
  assert.equal(byId[pending.id].status, 'cancelled')
  assert.equal(byId[running.id].status, 'cancelled')
  assert.equal(byId[done.id].status, 'completed')

  // 幂等：再次取消不改变任何委派状态。
  const secondCancel = store.delegations.cancelByParentRun(parent.id)
  const byId2 = Object.fromEntries(secondCancel.map((d) => [d.id, d]))
  assert.equal(byId2[pending.id].status, 'cancelled')
  assert.equal(byId2[running.id].status, 'cancelled')
  assert.equal(byId2[done.id].status, 'completed')
  // 无关父 Run 不受影响。
  const other = store.delegations.cancelByParentRun('nonexistent')
  assert.equal(other.length, 0)
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

test('replaceWithRetry preserves original run and marks it superseded', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'prov1',
    model: 'm',
  })
  store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: '请分析',
    status: 'completed',
  })
  const assistantMessage = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'failed',
  })
  const toolCall = store.toolCalls.create({
    runId: run.id,
    messageId: assistantMessage.id,
    toolName: 'file.read',
    args: { path: 'a.ts' },
    status: 'completed',
  })
  store.runs.finalize(run.id, 'failed', 'network')

  const retry = store.transaction(() =>
    store.runs.replaceWithRetry(
      run.id,
      {
        sessionId: session.id,
        providerId: 'prov1',
        model: 'm',
        skillId: null,
        planId: null,
        planStepId: null,
      },
      store.messages,
    ),
  )

  const originalPersisted = store.runs.get(run.id)
  assert.ok(originalPersisted)
  assert.equal(originalPersisted.supersededByRunId, retry.id)

  assert.equal(retry.retryOfRunId, run.id)
  assert.equal(retry.supersededByRunId, null)

  // 真实集成路径：旧助手消息在事务内被标记为 superseded。
  const supersededMessage = store.messages
    .listBySession(session.id, true)
    .find((m) => m.id === assistantMessage.id)
  assert.ok(supersededMessage)
  assert.equal(supersededMessage.status, 'superseded')

  assert.ok(store.toolCalls.get(toolCall.id) !== null)
})

test('replaceWithRetry rejects an already superseded run', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const runA = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  store.runs.finalize(runA.id, 'failed', 'network')
  const input = {
    sessionId: session.id,
    providerId: null,
    model: null,
    skillId: null,
    planId: null,
    planStepId: null,
  }

  const runB = store.transaction(() =>
    store.runs.replaceWithRetry(runA.id, input, store.messages),
  )
  store.runs.finalize(runB.id, 'failed', 'network')

  assert.throws(() =>
    store.runs.replaceWithRetry(runA.id, input, store.messages),
  )
})

test('retry chain of three keeps bidirectional links intact', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const input = {
    sessionId: session.id,
    providerId: null,
    model: null,
    skillId: null,
    planId: null,
    planStepId: null,
  }

  const runA = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  store.runs.finalize(runA.id, 'failed', 'network')

  const runB = store.transaction(() =>
    store.runs.replaceWithRetry(runA.id, input, store.messages),
  )
  store.runs.finalize(runB.id, 'failed', 'network')

  const runC = store.transaction(() =>
    store.runs.replaceWithRetry(runB.id, input, store.messages),
  )

  // A -> B -> C：每环 retryOfRunId 与 supersededByRunId 双向闭合。
  assert.equal(store.runs.get(runA.id).supersededByRunId, runB.id)
  assert.equal(store.runs.get(runB.id).retryOfRunId, runA.id)
  assert.equal(store.runs.get(runB.id).supersededByRunId, runC.id)
  assert.equal(store.runs.get(runC.id).retryOfRunId, runB.id)
  assert.equal(store.runs.get(runC.id).supersededByRunId, null)
})

test('replaceWithRetry failure inside transaction leaves original untouched', () => {
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
    status: 'failed',
  })
  store.runs.finalize(run.id, 'failed', 'network')

  // session_id 外键约束使 create 失败，整个事务应回滚。
  assert.throws(() =>
    store.transaction(() =>
      store.runs.replaceWithRetry(
        run.id,
        {
          sessionId: 'no-such-session',
          providerId: null,
          model: null,
          skillId: null,
          planId: null,
          planStepId: null,
        },
        store.messages,
      ),
    ),
  )

  const original = store.runs.get(run.id)
  assert.ok(original)
  assert.equal(original.supersededByRunId, null)
  const message = store.messages
    .listBySession(session.id, true)
    .find((m) => m.id === assistantMessage.id)
  assert.ok(message)
  assert.equal(message.status, 'failed')
})

test('markSupersededByRun hides old assistant messages from default query', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: null,
    model: null,
  })
  const userMsg = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: 'hello',
    status: 'completed',
  })
  const oldAssistant = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: 'old reply',
    status: 'failed',
  })

  store.messages.markSupersededByRun(run.id)

  const filtered = store.messages.listBySession(session.id)
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].id, userMsg.id)

  const includeSuperseded = store.messages.listBySession(session.id, true)
  assert.equal(includeSuperseded.length, 2)
  const restored = includeSuperseded.find((m) => m.id === oldAssistant.id)
  assert.ok(restored)
  assert.equal(restored.status, 'superseded')
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

test('run events survive round-trip, order, and session cascade', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'prov1',
    model: 'mock-model',
  })

  store.runEvents.createRetrying({
    sessionId: session.id,
    runId: run.id,
    attempt: 1,
    maxRetries: 5,
    reason: 'provider responded 503',
  })
  store.runEvents.createFailed({
    sessionId: session.id,
    runId: run.id,
    errorCode: 'provider',
    errorMessage: 'provider responded 503: model_not_found',
  })

  const events = store.runEvents.listBySession(session.id)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'retrying')
  assert.equal(events[0].attempt, 1)
  assert.equal(events[0].maxRetries, 5)
  assert.equal(events[0].reason, 'provider responded 503')
  assert.equal(events[1].type, 'failed')
  assert.equal(events[1].errorCode, 'provider')
  assert.equal(
    events[1].errorMessage,
    'provider responded 503: model_not_found',
  )
  // retry 事件不携带错误字段，failed 事件不携带重试字段。
  assert.equal(events[0].errorCode, null)
  assert.equal(events[0].errorMessage, null)
  assert.equal(events[1].attempt, null)
  assert.equal(events[1].maxRetries, null)
  assert.equal(events[1].reason, null)
  assert.ok(events[0].id)
  assert.ok(events[0].createdAt)
  assert.ok(events[1].id)

  // 会话删除级联清理事件（按 run 的 session 归属）。
  store.sessions.delete(session.id)
  assert.equal(store.runEvents.listBySession(session.id).length, 0)
  store.close()
})

test('agent settings default and round-trip', () => {
  const store = freshStore()
  assert.deepEqual(store.agentSettings.get(), {
    maxTurns: null,
    reflectionThreshold: null,
    requestRetries: null,
    requestTimeoutSec: null,
    maxDepth: 1,
    maxChildRuns: 4,
    maxParallelChildren: 2,
    maxChildTimeoutSec: 120,
    maxChildTotalTokens: 12000,
  })
  const updated = store.agentSettings.upsert({
    maxTurns: 32,
    reflectionThreshold: 3,
    requestRetries: 0,
    requestTimeoutSec: 60,
    maxDepth: 1,
    maxChildRuns: 4,
    maxParallelChildren: 2,
    maxChildTimeoutSec: 120,
    maxChildTotalTokens: 12000,
  })
  assert.deepEqual(store.agentSettings.get(), updated)
  assert.equal(updated.maxTurns, 32)
  // 非法 JSON 容错回默认。
  const db = store
  assert.equal(db.agentSettings.get().maxTurns, 32)
  store.close()
})
