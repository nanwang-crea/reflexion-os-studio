import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderError, streamChatCompletion } from '../../dist/provider.js'
import { startServer, sseBody } from '../fixtures/provider-server.mjs'

test('retries a request timeout with a fresh timeout per attempt', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    if (calls === 1) {
      setTimeout(() => response.end(), 80)
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
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
      timeoutMs: 30,
      maxRetries: 1,
      onRetry: (retry) => retries.push(retry),
    },
    () => {},
  )
  server.close()
  assert.equal(calls, 2)
  assert.equal(result.content, 'Hello')
  assert.equal(retries.length, 1)
  assert.match(retries[0].reason, /^timeout:/)
})

test('user abort during timeout retry backoff stops further attempts', async () => {
  const controller = new AbortController()
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    setTimeout(() => response.end(), 80)
  })
  const pending = streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      timeoutMs: 20,
      maxRetries: 2,
    },
    () => {},
  )
  setTimeout(() => controller.abort(), 80)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  server.close()
  assert.equal(calls, 1)
})

test('retries a stream read timeout with a fresh timeout per attempt', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    if (calls === 1) {
      response.write(
        'data: {"choices":[{"delta":{"content":"partial"}}]}\\n\\n',
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
      timeoutMs: 20,
      maxRetries: 1,
      onRetry: (retry) => retries.push(retry),
    },
    () => {},
  )
  server.close()
  assert.equal(calls, 2)
  assert.equal(result.content, 'Hello')
  assert.equal(retries.length, 1)
  assert.match(retries[0].reason, /^timeout:/)
})

test('maxRetries=0 maps a stream read timeout to timeout', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\\n\\n')
  })
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        timeoutMs: 20,
        maxRetries: 0,
      },
      () => {},
    ),
    (error) => error instanceof ProviderError && error.code === 'timeout',
  )
  server.close()
  assert.equal(calls, 1)
})

test('user abort during stream reading does not retry', async () => {
  const controller = new AbortController()
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"a"}}]}\\n\\n')
  })
  const pending = streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      timeoutMs: 200,
      maxRetries: 1,
    },
    () => {},
  )
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  server.close()
  assert.equal(calls, 1)
})

test('maxRetries=0 does not retry a request timeout', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    setTimeout(() => response.end(), 80)
  })
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        timeoutMs: 20,
        maxRetries: 0,
      },
      () => {},
    ),
    (error) => error instanceof ProviderError && error.code === 'timeout',
  )
  server.close()
  assert.equal(calls, 1)
})

test('maxRetries=0 fails fast on 429', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end('{"error":"rate limited"}')
  })
  const port = server.address().port
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        maxRetries: 0,
      },
      () => {},
    ),
    (error) => error instanceof ProviderError && error.code === 'rate_limit',
  )
  server.close()
  assert.equal(calls, 1)
})
