import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coerceToolOutput } from '@reflexion-os-studio/contracts'
import { registerDeveloperNotifications } from '../../dist/diagnostics/events.js'
import { observeModelInvocation } from '../../dist/diagnostics/model-invocation.js'
import { executeToolCall } from '../../dist/agent/run/tool-executor.js'
import { fixture, request } from './fixture.mjs'

const modelInput = (f) => ({
  sessionId: f.run.sessionId,
  runId: f.run.id,
  messageId: f.message.id,
  providerId: f.run.providerId,
  model: f.run.model,
  purpose: 'chat',
  signal: new AbortController().signal,
})

test('diagnostic notification failure does not block the request or undo a committed success', async (t) => {
  const f = fixture(t)
  registerDeveloperNotifications(f.store, () => {
    throw new Error('notification unavailable')
  })
  let calls = 0
  const result = await observeModelInvocation(
    f.store,
    modelInput(f),
    async () => {
      calls++
      return { content: 'ok', usage: { promptTokens: 5, completionTokens: 2 } }
    },
  )
  assert.equal(calls, 1)
  assert.equal(result.content, 'ok')
  assert.equal(f.store.runs.get(f.run.id).usage.promptTokens, 5)
  assert.equal(
    f.store.developer.models.list({ runId: f.run.id }).items[0].status,
    'completed',
  )
})

test('failed diagnostic persistence never replaces the original model failure', async (t) => {
  const f = fixture(t)
  const original = new Error('original model failure')
  t.mock.method(f.store.modelInvocations, 'finish', () => {
    throw new Error('diagnostics unavailable')
  })
  await assert.rejects(
    observeModelInvocation(f.store, modelInput(f), async () => {
      throw original
    }),
    (error) => error === original,
  )
})

test('timing persistence failure cannot hide a completed tool operation or its canonical result', async (t) => {
  const f = fixture(t)
  f.store.db
    .exec(`CREATE TRIGGER fail_timing BEFORE UPDATE OF timing_json ON tool_calls
    WHEN json_extract(NEW.timing_json, '$.executionMs') IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'timing write unavailable'); END`)
  let calls = 0
  f.registry.register({
    name: 'file.write',
    description: 'write',
    parameters: { type: 'object' },
    execute: async () => {
      calls++
      return { content: 'write committed', isError: false }
    },
  })
  const result = await executeToolCall(
    f,
    request('write', 'file.write', { path: 'new.txt', content: 'example' }),
    new AbortController().signal,
  )
  assert.equal(calls, 1)
  assert.equal(result.isError, false)
  const call = f.store.toolCalls.listByRun(f.run.id)[0]
  assert.equal(call.status, 'completed')
  assert.equal(call.output.content, 'write committed')
  assert.ok(call.timing.executionStartedAt)
  assert.equal(call.timing.executionMs, undefined)
})

test('invalid optional timing never makes canonical tool history unreadable', (t) => {
  const f = fixture(t)
  const tool = f.store.toolCalls.create({
    runId: f.run.id,
    messageId: f.message.id,
    toolName: 'file.read',
    args: {},
  })
  f.store.toolCalls.finalize(
    tool.id,
    'completed',
    coerceToolOutput('stored result'),
  )
  for (const invalid of [
    '{',
    '{"version":99}',
    '{"version":1,"executionMs":-1}',
  ]) {
    f.store.db
      .prepare('UPDATE tool_calls SET timing_json = ? WHERE id = ?')
      .run(invalid, tool.id)
    const restored = f.store.toolCalls.get(tool.id)
    assert.equal(restored.timing, null)
    assert.equal(restored.output.content, 'stored result')
  }
})
