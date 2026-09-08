import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { RunRunner } from '../dist/agent/runner.js'
import { RunFinalizer } from '../dist/agent/run-finalizer.js'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { ApprovalGateway, PermissionGate } from '../dist/agent/permissions.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-finalizer-')))
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function baseInput(store, run, overrides = {}) {
  return {
    run,
    provider: {
      baseUrl: `http://127.0.0.1:${overrides.port}/v1`,
      apiKey: 'key',
      model: 'model',
      maxRetries: 0,
    },
    buildHistory: async () => [{ role: 'user', content: 'hello' }],
    registry: new ToolRegistry(),
    workspaceRoot: null,
    gate: new PermissionGate('workspace', false),
    approvals: new ApprovalGateway(),
    settings: { maxTurns: 4 },
    memory: null,
    controller: overrides.controller ?? new AbortController(),
    emitter: overrides.emitter ?? new RunEventEmitter(run.id, () => {}),
    firstAssistantMessage: store.messages.create({
      sessionId: run.sessionId,
      runId: run.id,
      role: 'assistant',
      content: '',
      status: 'pending',
    }),
    onResult: overrides.onResult,
    onFailure: overrides.onFailure,
    onCancel: overrides.onCancel,
  }
}

test('stop without tool calls completes the run and fires onResult once', async () => {
  const store = freshStore()
  const run = store.runs.create({
    sessionId:
      store.projects.create({ name: 'p', folderPath: '/w' }).id &&
      store.sessions.create(store.projects.list()[0].id).id,
    providerId: 'provider',
    model: 'model',
  })
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      sseChunk({ choices: [{ delta: { content: 'done' } }] }) +
        sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n',
    )
  })
  let results = 0
  const events = []
  try {
    await new RunRunner(store).execute(
      baseInput(store, run, {
        port: server.address().port,
        onResult: () => {
          results += 1
        },
        emitter: new RunEventEmitter(run.id, (e) => events.push(e)),
      }),
    )
  } finally {
    server.close()
  }
  assert.equal(results, 1)
  assert.equal(store.runs.get(run.id).status, 'completed')
  assert.equal(store.runs.get(run.id).errorCode, null)
  assert.equal(events.filter((e) => e.type === 'run.completed').length, 1)
})

test('length → stop continues and stitches fragments into final result', async () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  let request = 0
  const server = await startServer((_req, res) => {
    request += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (request === 1) {
      res.end(
        sseChunk({ choices: [{ delta: { content: 'part1-' } }] }) +
          sseChunk({ choices: [{ delta: {}, finish_reason: 'length' }] }) +
          'data: [DONE]\n\n',
      )
      return
    }
    res.end(
      sseChunk({ choices: [{ delta: { content: 'part2' } }] }) +
        sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
        'data: [DONE]\n\n',
    )
  })
  let result = null
  try {
    await new RunRunner(store).execute(
      baseInput(store, run, {
        port: server.address().port,
        onResult: (value) => {
          result = value
        },
      }),
    )
  } finally {
    server.close()
  }
  assert.equal(result, 'part1-\n\npart2')
  assert.equal(store.runs.get(run.id).status, 'completed')
  // 两个 assistant 片段均已落库为 completed。
  const messages = store.messages.listBySession(session.id)
  const assistant = messages.filter((m) => m.role === 'assistant')
  assert.equal(assistant.length, 2)
  assert.equal(assistant[0].status, 'completed')
})

test('length continuation exhausted fails with output_truncated', async () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      sseChunk({ choices: [{ delta: { content: 'x' } }] }) +
        sseChunk({ choices: [{ delta: {}, finish_reason: 'length' }] }) +
        'data: [DONE]\n\n',
    )
  })
  let failure = null
  try {
    await new RunRunner(store).execute(
      baseInput(store, run, {
        port: server.address().port,
        onFailure: (error) => {
          failure = error
        },
      }),
    )
  } finally {
    server.close()
  }
  assert.notEqual(failure, null)
  assert.equal(store.runs.get(run.id).status, 'failed')
  assert.equal(store.runs.get(run.id).errorCode, 'output_truncated')
})

test('content_filter fails the run without completing the draft', async () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      sseChunk({ choices: [{ delta: { content: 'refuse' } }] }) +
        sseChunk({
          choices: [{ delta: {}, finish_reason: 'content_filter' }],
        }) +
        'data: [DONE]\n\n',
    )
  })
  const events = []
  try {
    await new RunRunner(store).execute(
      baseInput(store, run, {
        port: server.address().port,
        emitter: new RunEventEmitter(run.id, (e) => events.push(e)),
      }),
    )
  } finally {
    server.close()
  }
  assert.equal(store.runs.get(run.id).status, 'failed')
  assert.equal(store.runs.get(run.id).errorCode, 'content_filtered')
  // 草稿落 failed，且没有伪造 message.completed(stop)。
  const draft = store.messages
    .listBySession(session.id)
    .find((m) => m.role === 'assistant')
  assert.equal(draft.status, 'failed')
  assert.equal(
    events.some(
      (e) =>
        e.type === 'message.completed' && e.finishReason === 'content_filter',
    ),
    false,
  )
})

test('unknown finish_reason fails with provider_protocol instead of faking success', async () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      sseChunk({ choices: [{ delta: { content: 'looks done' } }] }) +
        sseChunk({ choices: [{ delta: {}, finish_reason: 'weird_reason' }] }) +
        'data: [DONE]\n\n',
    )
  })
  try {
    await new RunRunner(store).execute(
      baseInput(store, run, { port: server.address().port }),
    )
  } finally {
    server.close()
  }
  assert.equal(store.runs.get(run.id).status, 'failed')
  assert.equal(store.runs.get(run.id).errorCode, 'provider_protocol')
  // 草稿未落 completed。
  const draft = store.messages
    .listBySession(session.id)
    .find((m) => m.role === 'assistant')
  assert.equal(draft.status, 'failed')
})

test('max turns stops with stable max_turns code through the finalizer', async () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  // 每轮都请求工具（get_current_time 自动放行，未知工具会卡审批）：触发 max_turns。
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      sseChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'c1',
                  function: { name: 'get_current_time', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }) + 'data: [DONE]\n\n',
    )
  })
  const events = []
  try {
    await new RunRunner(store).execute(
      baseInput(store, run, {
        port: server.address().port,
        emitter: new RunEventEmitter(run.id, (e) => events.push(e)),
      }),
    )
  } finally {
    server.close()
  }
  assert.equal(store.runs.get(run.id).status, 'failed')
  assert.equal(store.runs.get(run.id).errorCode, 'max_turns')
  // 所有 ToolCall 都已收敛到终态（本轮调用实际执行失败为 failed，
  // 未开始/进行中的调用才被 Finalizer 取消）。
  const calls = store.toolCalls.listByRun(run.id)
  assert.equal(calls.length > 0, true)
  for (const call of calls) {
    assert.equal(
      ['completed', 'failed', 'cancelled'].includes(call.status),
      true,
      `tool call ${call.id} not terminal: ${call.status}`,
    )
  }
  const failedEvent = events.find((e) => e.type === 'run.failed')
  assert.equal(failedEvent.error.code, 'max_turns')
})

test('finalizer settles callbacks exactly once even when notifier throws', async () => {
  const store = freshStore()
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
      memory: null,
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
      planDisposition: 'keep',
      enqueueMemoryJob: false,
      resultContent: 'ok',
    },
  )
  assert.equal(results, 1)
  assert.equal(store.runs.get(run.id).status, 'completed')
  void runner
})

test('cancel converges draft to interrupted and fires onCancel once', async () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    // 长流：让客户端在读到第一块后取消。
    res.write(sseChunk({ choices: [{ delta: { content: 'slow' } }] }) + '\n')
  })
  const controller = new AbortController()
  let cancels = 0
  const pending = new RunRunner(store).execute(
    baseInput(store, run, {
      port: server.address().port,
      controller,
      onCancel: () => {
        cancels += 1
      },
    }),
  )
  setTimeout(() => controller.abort(), 50)
  await pending
  server.close()
  assert.equal(cancels, 1)
  assert.equal(store.runs.get(run.id).status, 'cancelled')
  const draft = store.messages
    .listBySession(session.id)
    .find((m) => m.role === 'assistant')
  assert.equal(draft.status, 'interrupted')
})

test('failed run converges its active plan to failed', () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const plan = store.plans.create({
    sessionId: session.id,
    messageId: null,
    goal: '完成多步任务',
    steps: [{ id: 'step-1', title: '第一步' }],
  })
  store.runs.attachPlan(run.id, plan.id, plan.steps[0]?.id ?? null)
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
      memory: null,
      provider: { baseUrl: 'http://localhost:1', apiKey: 'k', model: 'm' },
      onFailure: () => {},
    },
    {
      status: 'failed',
      errorCode: 'max_turns',
      errorMessage: '任务在 4 轮内未完成，已停止执行',
      pendingMessage: null,
      planDisposition: 'fail',
      enqueueMemoryJob: false,
    },
  )
  const updated = store.plans.get(plan.id)
  assert.equal(updated.status, 'failed')
  assert.equal(store.runs.get(run.id).status, 'failed')
  assert.equal(store.runs.get(run.id).errorCode, 'max_turns')
  assert.equal(
    events.some((e) => e.type === 'plan.updated'),
    true,
  )
  assert.equal(
    events.some((e) => e.type === 'run.failed'),
    true,
  )
  // 计划未完成步骤同步收敛为 failed。
  const planWithSteps = store.plans.get(plan.id)
  for (const step of planWithSteps.steps) {
    assert.equal(
      ['failed', 'completed', 'skipped', 'cancelled'].includes(step.status),
      true,
    )
  }
})

test('cancelled run converges its active plan to cancelled and draft to interrupted', () => {
  const store = freshStore()
  const session = store.sessions.create(
    store.projects.create({ name: 'p', folderPath: '/w' }).id,
  )
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const plan = store.plans.create({
    sessionId: session.id,
    messageId: null,
    goal: '被取消的计划',
    steps: [{ id: 'step-1', title: '第一步' }],
  })
  store.runs.attachPlan(run.id, plan.id, plan.steps[0]?.id ?? null)
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
      memory: null,
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
      planDisposition: 'cancel',
      enqueueMemoryJob: false,
    },
  )
  assert.equal(store.plans.get(plan.id).status, 'cancelled')
  assert.equal(store.runs.get(run.id).status, 'cancelled')
  assert.equal(
    store.messages.listBySession(session.id).find((m) => m.id === draft.id)
      .status,
    'interrupted',
  )
  assert.equal(cancels, 1)
})
