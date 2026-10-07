import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderError, streamChatCompletion } from '../../dist/provider.js'
import { startServer, sseBody } from '../fixtures/provider-server.mjs'

test('retries request establishment on 429 then succeeds', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    if (calls === 1) {
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end('{"error":"rate limited"}')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(sseBody())
  })
  const port = server.address().port
  const retries = []
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
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
  assert.deepEqual(retries, [
    { attempt: 1, maxRetries: 5, reason: 'HTTP 429', waitMs: 1000 },
  ])
  assert.equal(result.content, 'Hello')
})

test('retries a stream failure from a fresh attempt', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (calls === 1) {
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
      response.end()
      return
    }
    response.end(
      'data: {"choices":[{"delta":{"content":"retry-success"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
  })
  const retries = []
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      maxRetries: 1,
      onRetry: (retry) => retries.push(retry),
    },
    () => {},
  )
  server.close()
  assert.equal(calls, 2)
  assert.equal(result.content, 'retry-success')
  assert.equal(retries.length, 1)
  assert.equal(retries[0].attempt, 1)
  assert.match(retries[0].reason, /^stream failure:/)
})

test('exhausted stream retries reject without returning partial content', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    response.destroy()
  })
  const retries = []
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        maxRetries: 1,
        onRetry: (retry) => retries.push(retry),
      },
      () => {},
    ),
  )
  server.close()
  assert.equal(calls, 2)
  assert.equal(retries.length, 1)
})

test('does not retry a stream failure after user abort', async () => {
  const controller = new AbortController()
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    setTimeout(() => controller.abort(), 10)
    request.on('close', () => response.destroy())
  })
  const retries = []
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
        maxRetries: 1,
        onRetry: (retry) => retries.push(retry),
      },
      () => {},
    ),
    (error) => error.name === 'AbortError',
  )
  server.close()
  assert.equal(calls, 1)
  assert.equal(retries.length, 0)
})

test('retries malformed SSE data and returns only the successful attempt', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (calls === 1) {
      response.end('data: {malformed}\n\ndata: [DONE]\n\n')
      return
    }
    response.end(
      'data: {"choices":[{"delta":{"content":"valid"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
  })
  const retries = []
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      maxRetries: 1,
      onRetry: (retry) => retries.push(retry),
    },
    () => {},
  )
  server.close()
  assert.equal(calls, 2)
  assert.equal(result.content, 'valid')
  assert.equal(retries.length, 1)
  assert.match(retries[0].reason, /malformed SSE data/)
})

test('exhausted malformed SSE retries reject with ProviderError', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {malformed}\n\ndata: [DONE]\n\n')
  })
  const retries = []
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        maxRetries: 1,
        onRetry: (retry) => retries.push(retry),
      },
      () => {},
    ),
    (error) => error instanceof ProviderError && error.code === 'network',
  )
  server.close()
  assert.equal(calls, 2)
  assert.equal(retries.length, 1)
})

test('retries a successful response without a body', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    if (calls === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    )
  })
  const retries = []
  const result = await streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
      maxRetries: 1,
      onRetry: (retry) => retries.push(retry),
    },
    () => {},
  )
  server.close()
  assert.equal(calls, 2)
  assert.equal(result.content, '')
  assert.match(retries[0].reason, /stream failure:/)
})
