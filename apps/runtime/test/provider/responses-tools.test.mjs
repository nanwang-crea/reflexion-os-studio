import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamChat } from '../../dist/provider.js'
import { classifyModelTurn } from '@reflexion-os-studio/agent-core'

const added = (id, call_id, name) => ({
  type: 'response.output_item.added',
  item: { type: 'function_call', id, call_id, name, arguments: '' },
})
const delta = (item_id, text) => ({
  type: 'response.function_call_arguments.delta',
  item_id,
  delta: text,
})
const done = (id, call_id, name, arguments_) => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', id, call_id, name, arguments: arguments_ },
})
const terminal = (status = 'completed') => ({
  type: status === 'completed' ? 'response.completed' : 'response.incomplete',
  response: {
    status,
    ...(status === 'incomplete'
      ? { incomplete_details: { reason: 'max_output_tokens' } }
      : {}),
    usage: { input_tokens: 10, output_tokens: 5 },
  },
})

async function stream(events) {
  const originalFetch = globalThis.fetch
  let body
  globalThis.fetch = async (_url, request) => {
    body = JSON.parse(request.body)
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  try {
    const result = await streamChat(
      {
        baseUrl: 'http://mock.invalid',
        apiKey: 'test',
        model: 'mock',
        messages: [{ role: 'user', content: 'task', control: 'continuation' }],
        signal: new AbortController().signal,
        maxRetries: 0,
      },
      'openai-responses',
      () => {},
    )
    assert.equal(body.input[0].control, undefined)
    return result
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('standard Responses tool events yield one complete executable call', async () => {
  const result = await stream([
    added('fc_1', 'call_1', 'probe'),
    delta('fc_1', '{"x":'),
    delta('fc_1', '1}'),
    {
      type: 'response.function_call_arguments.done',
      item_id: 'fc_1',
      arguments: '{"x":1}',
    },
    done('fc_1', 'call_1', 'probe', '{"x":1}'),
    terminal(),
  ])
  assert.deepEqual(result.toolCalls, [
    { id: 'call_1', name: 'probe', arguments: '{"x":1}' },
  ])
  assert.deepEqual(classifyModelTurn(result.finishReason, result.toolCalls), {
    kind: 'tools',
  })
})

test('interleaved parallel Responses tool events retain separate arguments', async () => {
  const result = await stream([
    added('fc_1', 'call_1', 'first'),
    added('fc_2', 'call_2', 'second'),
    delta('fc_1', '{"a":'),
    delta('fc_2', '{"b":'),
    delta('fc_1', '1}'),
    delta('fc_2', '2}'),
    done('fc_2', 'call_2', 'second', '{"b":2}'),
    done('fc_1', 'call_1', 'first', '{"a":1}'),
    terminal(),
  ])
  assert.deepEqual(result.toolCalls, [
    { id: 'call_1', name: 'first', arguments: '{"a":1}' },
    { id: 'call_2', name: 'second', arguments: '{"b":2}' },
  ])
})

test('final output item arguments replace incomplete deltas without duplication', async () => {
  const result = await stream([
    added('fc', 'call', 'probe'),
    delta('fc', '{'),
    done('fc', 'call', 'probe', '{}'),
    terminal(),
  ])
  assert.equal(result.toolCalls[0].arguments, '{}')
  assert.equal(result.toolCalls.length, 1)
})

test('truncated standard tool stream retains its identity and cannot execute', async () => {
  const result = await stream([
    added('fc', 'call', 'probe'),
    delta('fc', '{'),
    terminal('incomplete'),
  ])
  assert.deepEqual(result.toolCalls, [
    { id: 'call', name: 'probe', arguments: '{' },
  ])
  assert.equal(
    classifyModelTurn(result.finishReason, result.toolCalls).kind,
    'tool_truncated',
  )
})

test('legacy call_id argument events remain supported', async () => {
  const result = await stream([
    {
      type: 'response.function_call_arguments.delta',
      call_id: 'call',
      delta: '{}',
    },
    done('fc', 'call', 'probe', '{}'),
    terminal(),
  ])
  assert.deepEqual(result.toolCalls, [
    { id: 'call', name: 'probe', arguments: '{}' },
  ])
})

test('unknown output item references fail closed without phantom calls', async () => {
  await assert.rejects(
    stream([delta('unknown', '{}'), terminal()]),
    (error) => error.code === 'provider_protocol',
  )
})
