import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { getEventListeners } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Store } from '../dist/store/index.js'
import { OperationRegistry } from '../dist/operations/registry.js'
import { SystemRuntimeClient, SystemRuntimeError } from '../dist/system.js'
import { requestSystem } from '../dist/workspace/shared.js'
import { callSystem } from '../dist/agent/tools/shared.js'
import { ContextBuilder } from '../dist/agent/context/context.js'
import { reconstructSessionFramesWithIds } from '../dist/agent/context/context-frames.js'
import {
  ensureCheckpoint,
  CHECKPOINT_SCHEMA_VERSION,
  computeSourceHash,
} from '../dist/agent/context/context-checkpoint.js'

// 临时目录统一在文件级 after 里删除：测试内的 store.close() 钩子注册得更晚，
// 若先删目录，Windows 上会因 SQLite 句柄尚未释放而 EBUSY。
const temporaryDirs = []
after(() => {
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-reliability-'))
  temporaryDirs.push(dir)
  return dir
}
const summary = {
  goal: 'Keep the task',
  constraints: [],
  decisions: [],
  completed: [],
  pending: [],
  toolFacts: [],
  knownErrors: [],
}
const provider = {
  baseUrl: 'http://checkpoint.invalid',
  apiKey: 'unused',
  model: 'm',
  contextBudget: 5000,
  maxRetries: 0,
}

function checkpointFixture(t) {
  const store = new Store(temporary())
  t.after(() => store.close())
  const session = store.sessions.create(null)
  const first = store.messages.create({
    sessionId: session.id,
    runId: null,
    role: 'user',
    content: 'Original request',
    status: 'completed',
  })
  const assistant = store.messages.create({
    sessionId: session.id,
    runId: null,
    role: 'assistant',
    content: 'Old answer',
    status: 'completed',
  })
  const stable = reconstructSessionFramesWithIds(
    store,
    session.id,
    '',
  ).frames.slice(1)
  const save = () =>
    store.contextCheckpoints.upsert({
      sessionId: session.id,
      throughMessageId: assistant.id,
      sourceHash: computeSourceHash(stable),
      summary,
      tokenEstimate: 10,
      model: 'm',
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    })
  save()
  return { store, session, first, assistant, stable, save }
}

test('checkpoint hit reads only suffix, uses one bulk tool query and invalidates edited prefix', async (t) => {
  const f = checkpointFixture(t)
  const next = f.store.messages.create({
    sessionId: f.session.id,
    runId: null,
    role: 'user',
    content: 'Newest task',
    status: 'completed',
  })
  let queries = 0
  const list = f.store.toolCalls.listByMessages.bind(f.store.toolCalls)
  f.store.toolCalls.listByMessages = (ids) => {
    queries++
    return list(ids)
  }
  f.store.toolCalls.listByMessage = () => {
    throw Error('N+1 query')
  }
  f.store.messages.listBySession = () => {
    throw Error('full history scan on checkpoint hit')
  }
  const result = await new ContextBuilder(f.store).build(
    f.session.id,
    'system',
    provider,
    new AbortController().signal,
  )
  assert.match(result[0].content, /Keep the task/)
  assert.ok(result.some((message) => message.content === 'Newest task'))
  assert.equal(queries, 1)
  f.store.messages.finalize(next.id, 'Updated tail', 'completed', '')
  assert.ok(
    f.store.contextCheckpoints.get(f.session.id),
    'tail update keeps prefix valid',
  )
  f.store.messages.finalize(
    f.first.id,
    'Edited original request',
    'completed',
    '',
  )
  assert.equal(f.store.contextCheckpoints.get(f.session.id), null)
})

test('late tools and superseded watermark invalidate checkpoint; async stale summaries never commit', async (t) => {
  const f = checkpointFixture(t)
  const run = f.store.runs.create({
    sessionId: f.session.id,
    providerId: 'p',
    model: 'm',
  })
  f.store.toolCalls.create({
    runId: run.id,
    messageId: f.assistant.id,
    toolName: 'get_current_time',
    args: {},
  })
  assert.equal(f.store.contextCheckpoints.get(f.session.id), null)
  f.save()
  f.store.messages.markSuperseded(f.assistant.id)
  assert.equal(f.store.contextCheckpoints.get(f.session.id), null)
  const outcome = await ensureCheckpoint({
    store: f.store,
    sessionId: f.session.id,
    provider,
    stableFrames: f.stable,
    throughMessageId: f.assistant.id,
    signal: new AbortController().signal,
    summarize: async () => summary,
    validateSource: () => false,
  })
  assert.equal(outcome.failed, true)
  assert.equal(f.store.contextCheckpoints.get(f.session.id), null)
})

test('five thousand mutations remain usable and old receipts prevent replay after restart', async (t) => {
  const dir = temporary()
  let store = new Store(dir)
  let registry = new OperationRegistry(undefined, store.operationReceipts)
  let count = 0
  const task = async () => {
    count++
    return { ok: true }
  }
  for (let i = 0; i < 5000; i++)
    await registry.execute(
      'workspace.write_file',
      { requestId: String(i) },
      task,
    )
  assert.equal(count, 5000)
  assert.equal(registry.get('workspace.write_file', '0').phase, 'succeeded')
  await assert.rejects(
    registry.execute('workspace.write_file', { requestId: '0' }, task),
    /禁止重新执行/,
  )
  store.close()
  store = new Store(dir)
  t.after(() => store.close())
  registry = new OperationRegistry(undefined, store.operationReceipts)
  await assert.rejects(
    registry.execute('workspace.write_file', { requestId: '0' }, task),
    /禁止重新执行/,
  )
  assert.equal(count, 5000)
  await registry.execute('workspace.write_file', { requestId: 'new' }, task)
  assert.equal(count, 5001)
})

test('restart marks unfinished receipts uncertain without reexecuting them', (t) => {
  const dir = temporary()
  let store = new Store(dir)
  store.operationReceipts.save('workspace.write_file:pending', 'hash', {
    requestId: 'pending',
    method: 'workspace.write_file',
    phase: 'running',
    error: null,
  })
  store.close()
  store = new Store(dir)
  t.after(() => store.close())
  assert.equal(
    new OperationRegistry(undefined, store.operationReceipts).get(
      'workspace.write_file',
      'pending',
    ).phase,
    'uncertain',
  )
})

function stub() {
  const dir = temporary(),
    path = join(dir, 'sidecar.mjs')
  writeFileSync(
    path,
    `import {createInterface} from 'node:readline';
const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');let timer;
emit({jsonrpc:'2.0',method:'system.ready',params:{protocolVersion:'1.3',runtimeVersion:'fixture',capabilities:[]}});
if(process.argv.includes('--crash'))setTimeout(()=>process.exit(2),20);
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='review.crash')process.exit(2);
if(m.method==='review.write')timer=setTimeout(()=>emit({jsonrpc:'2.0',id:m.id,result:{written:true}}),500);
if(m.method==='system.cancel'){clearTimeout(timer);emit({jsonrpc:'2.0',method:'review.cancelled',params:{}})}
if(m.method==='system.shutdown'){clearTimeout(timer);process.exit(0)}
});`,
  )
  return path
}

test('timeout sends cancel, releases listeners and propagates replay protection', async (t) => {
  const path = stub()
  let ready, cancelled
  const started = new Promise((resolve) => (ready = resolve))
  const stopped = new Promise((resolve) => (cancelled = resolve))
  const client = new SystemRuntimeClient(
    process.execPath,
    [path],
    (status) => {
      if (status === 'ready') ready()
    },
    (method) => {
      if (method === 'review.cancelled') cancelled()
    },
  )
  t.after(() => client.shutdown())
  client.start()
  await started
  const controller = new AbortController()
  await assert.rejects(
    client.request(
      'review.write',
      {},
      { timeoutMs: 20, signal: controller.signal },
    ),
    (error) => error.code === 'operation_uncertain',
  )
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await stopped
  const result = await callSystem(
    {
      request: async () => {
        throw new SystemRuntimeError('timeout', 'operation_uncertain')
      },
    },
    'file.write',
    {},
    controller.signal,
  )
  assert.equal(result.replayUnsafe, true)
  assert.equal(result.code, 'operation_uncertain')
})

test(
  'ready-then-crash loop exhausts the restart budget',
  { timeout: 12000 },
  async (t) => {
    const path = stub(),
      statuses = []
    const client = new SystemRuntimeClient(
      process.execPath,
      [path, '--crash'],
      (status) => statuses.push(status),
    )
    t.after(() => client.shutdown())
    client.start()
    while (statuses.filter((status) => status === 'degraded').length < 4)
      await delay(25)
    await delay(600)
    assert.equal(statuses.filter((status) => status === 'ready').length, 4)
    assert.equal(client.available, false)
  },
)

test('v52 migration preserves canonical history while discarding only rebuildable checkpoints', (t) => {
  const dir = temporary()
  let store = new Store(dir)
  const session = store.sessions.create(null)
  const message = store.messages.create({
    sessionId: session.id,
    runId: null,
    role: 'user',
    content: 'Preserve this history',
    status: 'completed',
  })
  store.contextCheckpoints.upsert({
    sessionId: session.id,
    throughMessageId: message.id,
    sourceHash: 'old',
    summary,
    tokenEstimate: 10,
    model: 'm',
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
  })
  store.db.exec('PRAGMA user_version = 52')
  store.close()
  store = new Store(dir)
  t.after(() => store.close())
  assert.equal(store.messages.get(message.id).content, 'Preserve this history')
  assert.equal(store.contextCheckpoints.get(session.id), null)
})

test('sidecar crash preserves uncertain status through tools, workspace calls and receipts', async (t) => {
  let ready
  const started = new Promise((resolve) => (ready = resolve))
  const client = new SystemRuntimeClient(
    process.execPath,
    [stub()],
    (status) => {
      if (status === 'ready') ready()
    },
  )
  t.after(() => client.shutdown())
  client.start()
  await started
  const controller = new AbortController()
  const tool = callSystem(client, 'review.write', {}, controller.signal)
  const registry = new OperationRegistry()
  const operation = registry.execute(
    'workspace.write_file',
    { requestId: 'crash' },
    () => requestSystem(client, 'review.write', {}),
  )
  // Register rejection handlers before crashing the child.
  const rejected = assert.rejects(
    operation,
    (error) => error.code === 'operation_uncertain',
  )
  await assert.rejects(
    client.request('review.crash'),
    (error) => error.code === 'operation_uncertain',
  )
  await rejected
  const result = await tool
  assert.equal(result.replayUnsafe, true)
  assert.equal(result.code, 'operation_uncertain')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(registry.get('workspace.write_file', 'crash').phase, 'uncertain')
})
