import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ProviderError,
  streamChat,
  streamChatCompletion,
} from '../../dist/provider.js'
import { startServer, sseBody } from '../fixtures/provider-server.mjs'

test('streamChatCompletion collects deltas, finish reason and usage', async () => {
  const server = await startServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions')
    assert.match(request.headers.authorization ?? '', /^Bearer sk-/)
    assert.equal(request.headers['x-client-name'], 'ReflexionOS Studio')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sseBody())
  })
  const port = server.address().port
  const deltas = []
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      headers: [{ name: 'X-Client-Name', value: 'ReflexionOS Studio' }],
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    },
    (delta) => deltas.push(delta),
  )
  server.close()

  assert.deepEqual(deltas, ['He', 'llo'])
  assert.equal(result.content, 'Hello')
  assert.equal(result.finishReason, 'stop')
  assert.deepEqual(result.usage, { promptTokens: 3, completionTokens: 2 })
})

test('strict finish reason: missing finish_reason fails with provider_protocol', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      'data: {"choices":[{"delta":{"content":"looks complete"}}]}\n\ndata: [DONE]\n\n',
    )
  })
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        maxRetries: 0,
      },
      () => {},
    ),
    (error) =>
      error instanceof ProviderError && error.code === 'provider_protocol',
  )
  server.close()
})

test('strict finish reason: unknown finish_reason value fails without retry', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      'data: {"choices":[{"delta":{"content":"x"}},{"choices":[]}]}\n\n'.replace(
        ',"choices":[]',
        '',
      ) +
        'data: {"choices":[{"delta":{},"finish_reason":"mystery"}]}\n\ndata: [DONE]\n\n',
    )
  })
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      },
      () => {},
    ),
    (error) =>
      error instanceof ProviderError && error.code === 'provider_protocol',
  )
  server.close()
  assert.equal(calls, 1)
})

test('missing finish_reason is retried as transient stream failure then succeeds', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (calls === 1) {
      response.end(
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n',
      )
      return
    }
    response.end(sseBody())
  })
  const retries = []
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      onRetry: (retry) => retries.push(retry),
    },
    () => {},
  )
  server.close()
  assert.equal(calls, 2)
  assert.equal(result.content, 'Hello')
  assert.equal(result.finishReason, 'stop')
  assert.equal(retries.length, 1)
  assert.match(retries[0].reason, /stream ended without a valid finish_reason/)
  assert.match(retries[0].reason, /done: true/)
})

test('anthropic missing stop_reason is retried as transient stream failure then succeeds', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const body =
      calls === 1
        ? 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\ndata: {"type":"message_stop"}\n\n'
        : 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\ndata: {"type":"message_stop"}\n\n'
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const result = await streamChat(
    {
      baseUrl: 'https://mock.invalid',
      apiKey: 'sk-test',
      model: 'm',
      messages: [],
      signal: new AbortController().signal,
    },
    'anthropic',
    () => {},
  )
  assert.equal(calls, 2)
  assert.equal(result.content, 'ok')
  assert.equal(result.finishReason, 'stop')
})

test('responses missing completion status is retried as transient stream failure then succeeds', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const body =
      calls === 1
        ? ''
        : 'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const result = await streamChat(
    {
      baseUrl: 'https://mock.invalid',
      apiKey: 'sk-test',
      model: 'm',
      messages: [],
      signal: new AbortController().signal,
    },
    'openai-responses',
    () => {},
  )
  assert.equal(calls, 2)
  assert.equal(result.finishReason, 'stop')
})
