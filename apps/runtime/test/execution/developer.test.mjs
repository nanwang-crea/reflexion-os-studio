import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandSchemaRegistry,
  coerceToolOutput,
} from '@reflexion-os-studio/contracts'
import { observeModelInvocation } from '../../dist/diagnostics/model-invocation.js'
import { Store } from '../../dist/store/index.js'
import { dispatchCommand } from '../../dist/handlers.js'
import { executeToolCall } from '../../dist/agent/run/tool-executor.js'
import { streamChat } from '../../dist/provider.js'
import { fixture, request, tick } from './fixture.mjs'

function invocation(f, run = f.run, purpose = 'chat') {
  return {
    sessionId: run.sessionId,
    runId: purpose === 'chat' ? run.id : null,
    messageId: null,
    providerId: run.providerId,
    model: run.model,
    purpose,
    signal: new AbortController().signal,
  }
}

test('usage counts parent, child and auxiliary calls once and preserves missing reports', async (t) => {
  const f = fixture(t)
  const child = f.store.runs.create({
    sessionId: f.run.sessionId,
    providerId: 'p',
    model: 'child-model',
    parentRunId: f.run.id,
  })
  await observeModelInvocation(f.store, invocation(f), async () => ({
    usage: { promptTokens: 100, completionTokens: 10, cachedPromptTokens: 40 },
  }))
  await observeModelInvocation(f.store, invocation(f, child), async () => ({
    usage: { promptTokens: 50, completionTokens: 5 },
  }))
  await observeModelInvocation(
    f.store,
    invocation(f, f.run, 'title'),
    async () => ({ usage: { promptTokens: 7, completionTokens: 2 } }),
  )
  await observeModelInvocation(
    f.store,
    invocation(f, f.run, 'summary'),
    async () => ({}),
  )
  await observeModelInvocation(f.store, invocation(f), async () => ({}))
  const overview = f.store.developer.overview.get({})
  assert.equal(overview.usage.promptTokens, 157)
  assert.equal(overview.usage.completionTokens, 17)
  assert.equal(overview.usage.cachedPromptTokens, 40)
  assert.equal(overview.usage.sources, 4)
  assert.equal(overview.usage.reportedSources, 3)
  assert.equal(overview.usage.unreportedCalls, 2)
  assert.equal(overview.usage.cacheReportedSources, 1)
  assert.equal(overview.usage.legacyRuns, 0)
  assert.equal(f.store.runs.get(f.run.id).usage.promptTokens, 100)
  const detail = f.store.developer.runs.get(f.run.id)
  assert.equal(detail.treeUsage.promptTokens, 150)
  assert.equal(detail.treeRuns, 2)
  assert.equal(detail.entry.childRuns, 1)
  assert.equal(
    f.store.developer.overview.get({ model: 'child-model' }).usage.promptTokens,
    50,
  )
})

test('date, project, provider filters and SQL-looking inputs remain exact and bounded', async (t) => {
  const f = fixture(t)
  const standalone = f.store.sessions.create(null)
  const outside = f.store.runs.create({
    sessionId: standalone.id,
    providerId: 'other',
    model: 'm',
  })
  f.store.runs.addUsage(f.run.id, { promptTokens: 20, completionTokens: 3 })
  f.store.runs.addUsage(outside.id, { promptTokens: 99, completionTokens: 8 })
  f.store.db
    .prepare('UPDATE runs SET started_at = ?')
    .run('2026-10-22T00:00:00.000Z')
  f.store.db
    .prepare('UPDATE runs SET started_at = ? WHERE id = ?')
    .run('2026-10-23T00:00:00.000Z', outside.id)
  assert.equal(
    f.store.developer.overview.get({ projectId: null }).usage.promptTokens,
    99,
  )
  const projectId = f.store.sessions.get(f.run.sessionId).projectId
  assert.equal(
    f.store.developer.overview.get({ projectId }).usage.promptTokens,
    20,
  )
  assert.equal(
    f.store.developer.overview.get({
      from: '2026-10-22T00:00:00Z',
      to: '2026-10-23T00:00:00Z',
    }).runs,
    1,
  )
  assert.equal(f.store.developer.overview.get({ providerId: 'other' }).runs, 1)
  assert.equal(
    f.store.developer.overview.get({ model: "' OR 1 = 1 --" }).runs,
    0,
  )
  assert.equal(f.store.developer.overview.get({}).usage.legacyRuns, 2)
  await assert.rejects(
    dispatchCommand(
      'developer.runs.list',
      { requestId: 'test', limit: 101 },
      { store: f.store },
    ),
    { code: 'invalid_request' },
  )
  await assert.rejects(
    dispatchCommand(
      'developer.overview',
      {
        requestId: 'test',
        from: '2026-10-23T00:00:00Z',
        to: '2026-10-22T00:00:00Z',
      },
      { store: f.store },
    ),
    { code: 'invalid_request' },
  )
})

test('Run and tool pagination is stable at equal timestamps, with status filtering', (t) => {
  const f = fixture(t)
  for (let n = 0; n < 30; n++) {
    const run = f.store.runs.create({
      sessionId: f.run.sessionId,
      providerId: 'p',
      model: 'm',
    })
    f.store.runs.finalize(run.id, n % 2 ? 'failed' : 'completed')
    const tool = f.store.toolCalls.create({
      runId: run.id,
      messageId: null,
      toolName: 'file.read',
      args: { path: 'a' },
    })
    f.store.toolCalls.finalize(
      tool.id,
      n % 2 ? 'failed' : 'completed',
      coerceToolOutput('full result'),
    )
  }
  f.store.db.exec(
    "UPDATE runs SET started_at = '2026-10-22T00:00:00.000Z'; UPDATE tool_calls SET created_at = '2026-10-22T00:00:00.000Z'",
  )
  const runs = [0, 10, 20, 30].flatMap(
    (offset) => f.store.developer.runs.list({ offset, limit: 10 }).items,
  )
  assert.equal(new Set(runs.map((entry) => entry.run.id)).size, 31)
  assert.equal(f.store.developer.runs.list({ status: 'failed' }).total, 15)
  const tools = [0, 10, 20].flatMap(
    (offset) => f.store.developer.tools.list({ offset, limit: 10 }).items,
  )
  assert.equal(new Set(tools.map((entry) => entry.id)).size, 30)
  assert.ok(tools.every((entry) => !('args' in entry) && !('output' in entry)))
  assert.equal(
    f.store.developer.tools.list({ status: 'failed', toolName: 'file.read' })
      .total,
    15,
  )
})

test('tool details reuse canonical output, omit grants and preserve unknown historical timing', async (t) => {
  const f = fixture(t)
  const tool = f.store.toolCalls.create({
    runId: f.run.id,
    messageId: f.message.id,
    toolName: 'test',
    args: { value: 1 },
    approvalGrantId: 'internal-grant',
  })
  f.store.toolCalls.finalize(
    tool.id,
    'failed',
    coerceToolOutput('complete failure body'),
    'tool_error',
  )
  const result = await dispatchCommand(
    'developer.tool.get',
    { requestId: 'get', toolCallId: tool.id },
    { store: f.store },
  )
  CommandSchemaRegistry['developer.tool.get'].result.parse(result)
  assert.equal(result.detail.output.content, 'complete failure body')
  assert.equal(result.detail.errorCode, 'tool_error')
  assert.equal(result.detail.timing, null)
  assert.equal('approvalGrantId' in result.detail, false)
  assert.deepEqual(
    await dispatchCommand(
      'developer.run.get',
      { requestId: 'get', runId: 'missing' },
      { store: f.store },
    ),
    { detail: null },
  )
})

test('actual tool path records approval and execution separately; denied calls have no execution duration', async (t) => {
  const f = fixture(t, 'workspace-write', 'ask-everything')
  f.registry.register({
    name: 'file.read',
    description: 'read',
    parameters: { type: 'object' },
    execute: async () => ({ content: 'ok', isError: false }),
  })
  for (const decision of ['allow-once', 'deny']) {
    const pending = executeToolCall(
      f,
      request(decision, 'file.read', { path: 'a.txt' }),
      new AbortController().signal,
    )
    await tick()
    const event = f.events
      .filter((value) => value.type === 'approval.required')
      .at(-1)
    assert.ok(event)
    f.approvals.resolveChoice(event.toolCallId, decision)
    await pending
    const call = f.store.toolCalls.get(event.toolCallId)
    assert.ok(call.timing.approvalWaitMs >= 0)
    if (decision === 'deny') assert.equal(call.timing.executionMs, undefined)
    else {
      assert.ok(call.timing.executionMs >= 0)
      assert.ok(call.timing.executionStartedAt)
    }
  }
})

test('failure, cancellation, crash recovery and cascade keep unknown usage without response content', async (t) => {
  const f = fixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    observeModelInvocation(
      f.store,
      { ...invocation(f), signal: controller.signal },
      async () => {
        throw new Error('private response')
      },
    ),
  )
  const pendingId = f.store.modelInvocations.start({
    ...invocation(f),
    purpose: 'summary',
  })
  const reopened = new Store(f.workspaceRoot)
  try {
    const records = reopened.developer.models.list({}).items
    assert.equal(
      records.find((entry) => entry.id === pendingId).status,
      'interrupted',
    )
    assert.equal(
      records.find((entry) => entry.id === pendingId).durationMs,
      null,
    )
    assert.ok(records.some((entry) => entry.status === 'cancelled'))
    assert.ok(records.every((entry) => entry.usage === null))
    assert.equal(JSON.stringify(records).includes('private response'), false)
    reopened.sessions.delete(f.run.sessionId)
    assert.equal(reopened.developer.models.list({}).total, 0)
  } finally {
    reopened.close()
  }
})

test('v53 migration preserves Run usage and canonical results without fabricating old diagnostics', (t) => {
  const f = fixture(t)
  f.store.runs.addUsage(f.run.id, { promptTokens: 42, completionTokens: 7 })
  const tool = f.store.toolCalls.create({
    runId: f.run.id,
    messageId: null,
    toolName: 'test',
    args: {},
  })
  f.store.toolCalls.finalize(
    tool.id,
    'completed',
    coerceToolOutput('old result'),
  )
  f.store.db.exec(
    'DROP TABLE model_invocations; ALTER TABLE tool_calls DROP COLUMN timing_json; PRAGMA user_version = 53',
  )
  const migrated = new Store(f.workspaceRoot)
  try {
    assert.equal(migrated.developer.overview.get({}).usage.promptTokens, 42)
    assert.equal(
      migrated.developer.tools.get(tool.id).output.content,
      'old result',
    )
    assert.equal(migrated.developer.tools.get(tool.id).timing, null)
    assert.equal(migrated.developer.models.list({}).total, 0)
  } finally {
    migrated.close()
  }
})

test('request diagnostics strip preview content before returning and paginate attempts', (t) => {
  const f = fixture(t)
  for (let attempt = 1; attempt <= 12; attempt++)
    f.store.messages.recordAttempt(f.message.id, {
      id: `attempt-${attempt}`,
      attempt,
      status: 'failed',
      phase: 'stream',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 10,
      maxIdleMs: 5,
      receivedBytes: 123,
      content: 'private preview',
      reasoning: 'private reasoning',
    })
  const page = f.store.developer.models.attempts(f.message.id, 10, 10)
  assert.equal(page.total, 12)
  assert.equal(page.items.length, 2)
  assert.equal('content' in page.items[0], false)
  assert.equal('reasoning' in page.items[0], false)
})

test('all Provider adapters distinguish missing usage from reported zero', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const event = (value) => `data: ${JSON.stringify(value)}\n\n`
  const bodies = {
    'openai-chat':
      event({
        choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
      }) + 'data: [DONE]\n\n',
    'openai-responses': event({
      type: 'response.completed',
      response: { status: 'completed' },
    }),
    anthropic:
      event({ type: 'message_start', message: {} }) +
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
      event({ type: 'message_stop' }),
  }
  for (const [format, body] of Object.entries(bodies)) {
    globalThis.fetch = async () => new Response(body)
    const result = await streamChat(
      {
        baseUrl: 'https://mock.invalid',
        apiKey: 'test',
        model: 'm',
        messages: [],
        signal: new AbortController().signal,
        maxRetries: 0,
      },
      format,
      () => {},
    )
    assert.equal(result.usage, undefined, format)
  }
})
