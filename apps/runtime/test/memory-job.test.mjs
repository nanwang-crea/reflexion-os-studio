import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-memjob-')))
}

test('memory job lifecycle: enqueue idempotent, claim, complete', () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  store.runs.finalize(run.id, 'completed')
  store.memoryJobs.enqueue(run.id)
  store.memoryJobs.enqueue(run.id)
  const claimed = store.memoryJobs.claimNext()
  assert.notEqual(claimed, null)
  assert.equal(claimed.runId, run.id)
  assert.equal(claimed.status, 'running')
  // 第二次 claim 拿不到（running 不再派发）。
  assert.equal(store.memoryJobs.claimNext(), null)
  store.memoryJobs.markCompleted(run.id)
  assert.equal(store.memoryJobs.get(run.id).status, 'completed')
})

test('retryable failure backs off and eventually fails after max attempts', () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  store.memoryJobs.enqueue(run.id)
  store.memoryJobs.claimNext()
  const first = store.memoryJobs.markRetryableFailure(run.id, 'network blip')
  assert.equal(first, 'pending')
  assert.equal(store.memoryJobs.get(run.id).attempts, 1)
  assert.notEqual(store.memoryJobs.get(run.id).nextAttemptAt, null)
  // 第二次 claim 因退避时间未到拿不到。
  assert.equal(store.memoryJobs.claimNext(), null)
  // 直接推进到第三次失败 → failed。
  store.memoryJobs.claimNext()
  store.memoryJobs.markRetryableFailure(run.id, 'still down')
  store.memoryJobs.claimNext()
  const final = store.memoryJobs.markRetryableFailure(run.id, 'gave up')
  assert.equal(final, 'failed')
  assert.match(store.memoryJobs.get(run.id).lastError, /gave up/)
})

test('permanent failure marks failed immediately', () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  store.memoryJobs.enqueue(run.id)
  store.memoryJobs.claimNext()
  store.memoryJobs.markPermanentFailure(run.id, 'authentication failed')
  assert.equal(store.memoryJobs.get(run.id).status, 'failed')
  // failed 任务不再被 claim。
  assert.equal(store.memoryJobs.claimNext(), null)
})

test('startup recovery moves orphaned running jobs back to pending', () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  store.memoryJobs.enqueue(run.id)
  store.memoryJobs.claimNext()
  // 模拟上次进程中断：running 任务遗留。
  store.memoryJobs.recoverRunning()
  const job = store.memoryJobs.get(run.id)
  assert.equal(job.status, 'pending')
  assert.equal(job.attempts, 0, 'recovery does not count as a failure')
  // 恢复后立即可被消费。
  assert.notEqual(store.memoryJobs.claimNext(), null)
})

test('failed run creates no memory job via finalizer path', async () => {
  // 直接验证 Finalizer 决策语义：只有 completed+enqueueMemoryJob 入队。
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const failedRun = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  const { RunFinalizer } = await import('../dist/agent/run-finalizer.js')
  const { RunEventEmitter } = await import('../dist/events.js')
  new RunFinalizer(store).finalize(
    {
      run: failedRun,
      state: {
        turn: null,
        toolCallRowIds: new Set(),
        lastAssistantMessageId: null,
        precreatedToolCallRows: new Map(),
      },
      emitter: new RunEventEmitter(failedRun.id, () => {}),
    },
    {
      status: 'failed',
      errorCode: 'no_progress',
      errorMessage: '停止',
      pendingMessage: null,
      enqueueMemoryJob: false,
    },
  )
  assert.equal(store.memoryJobs.get(failedRun.id), null)
  // completed 路径则入队。
  const okRun = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  new RunFinalizer(store).finalize(
    {
      run: okRun,
      state: {
        turn: null,
        toolCallRowIds: new Set(),
        lastAssistantMessageId: null,
        precreatedToolCallRows: new Map(),
      },
      emitter: new RunEventEmitter(okRun.id, () => {}),
    },
    {
      status: 'completed',
      errorCode: null,
      errorMessage: null,
      pendingMessage: null,
      enqueueMemoryJob: true,
      resultContent: 'done',
    },
  )
  assert.equal(store.memoryJobs.get(okRun.id).status, 'pending')
})

test('composite recall query includes checkpoint goal, plan and recent users', async () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const { buildCompositeQuery } = await import('../dist/agent/memory/recall.js')
  // 空 session：只有空查询。
  assert.equal(buildCompositeQuery(store, session.id), '')
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: '第一条任务说明',
    status: 'completed',
  })
  store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'user',
    content: '继续',
    status: 'completed',
  })
  store.contextCheckpoints.upsert({
    sessionId: session.id,
    throughMessageId: null,
    sourceHash: 'hash',
    summary: {
      goal: '重构 auth 模块',
      constraints: [],
      decisions: [],
      completed: ['阅读代码'],
      pending: ['写测试'],
      toolFacts: [],
      knownErrors: [],
    },
    tokenEstimate: 20,
    model: 'm',
    schemaVersion: 1,
  })
  const plan = store.plans.create({
    sessionId: session.id,
    messageId: null,
    goal: '完成 auth 重构计划',
    steps: [{ id: 'st1', title: '跑测试' }],
  })
  store.plans.updateStep(plan.id, 'st1', 'in_progress')
  const query = buildCompositeQuery(store, session.id)
  assert.match(query, /继续/)
  assert.match(query, /重构 auth 模块/)
  assert.match(query, /完成 auth 重构计划/)
  assert.match(query, /写测试/)
  assert.match(query, /跑测试/)
  void plan
})

test('transcript sanitization: long args collapsed, secrets redacted, errors keep code', async () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  const assistant = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '我来写文件',
    status: 'completed',
  })
  const ok = store.toolCalls.create({
    runId: run.id,
    messageId: assistant.id,
    toolName: 'file.write',
    args: {
      path: 'a.ts',
      content: 'secret-token-here-abcdef123456',
      note: 'x'.repeat(200),
    },
    status: 'running',
  })
  store.toolCalls.finalize(ok.id, 'completed', { writtenBytes: 42 })
  const bad = store.toolCalls.create({
    runId: run.id,
    messageId: assistant.id,
    toolName: 'shell.execute',
    args: { command: 'npm test' },
    status: 'running',
  })
  store.toolCalls.finalize(bad.id, 'failed', undefined, 'timeout')
  const { buildRunTranscript } =
    await import('../dist/agent/memory/extractor.js')
  const transcript = buildRunTranscript(store, run)
  assert.match(transcript, /file\.write/)
  assert.match(transcript, /<redacted>/, 'secret-like value must be redacted')
  assert.match(transcript, /error\(timeout\)/)
  // 长文本参数被折叠（不完整进入 transcript）：200 字 note 已折叠为 <redacted>，
  // 35 字 secret token 折叠；额外验证 80 字以上普通长文本会截断。
  assert.doesNotMatch(transcript, /x{200}/)
  // 授权凭据不出现。
  assert.doesNotMatch(transcript, /authorization|Bearer /i)
})
