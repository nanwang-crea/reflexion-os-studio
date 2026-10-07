import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderError, streamChatCompletion } from '../../dist/provider.js'
import { startServer, sseBody } from '../fixtures/provider-server.mjs'

test('maps HTTP status to stable error codes', async () => {
  const server = await startServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":"bad key"}')
  })
  const port = server.address().port
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-wrong',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      },
      () => {},
    ),
    (error) =>
      error instanceof ProviderError && error.code === 'authentication',
  )
  server.close()
})

test('connection failure maps to network', async () => {
  // 端口 1 几乎必然拒绝连接。maxRetries: 0 跳过退避（重试/退避行为由其他
  // 用例专门覆盖），否则 5 次指数退避要让本用例空等 ~30 秒。
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
        maxRetries: 0,
      },
      () => {},
    ),
    (error) => error instanceof ProviderError && error.code === 'network',
  )
})

test('user abort propagates as AbortError', async () => {
  const controller = new AbortController()
  const server = await startServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
    // 保持连接不结束，等待客户端 abort
    request.on('close', () => response.end())
  })
  const port = server.address().port
  const pending = streamChatCompletion(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    },
    () => {},
  )
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  server.close()
})

test('retries recoverable HTTP 400 errors', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    if (calls === 1) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(
        '{"error":{"type":"temporary_error","message":"please try again"}}',
      )
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
      maxRetries: 1,
      onRetry: (retry) => retries.push(retry),
    },
    () => {},
  )
  server.close()
  assert.equal(result.content, 'Hello')
  assert.equal(calls, 2)
  assert.deepEqual(retries, [
    { attempt: 1, maxRetries: 1, reason: 'HTTP 400', waitMs: 1000 },
  ])
})

test('does not retry non-recoverable HTTP 400 errors', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(
      '{"error":{"type":"invalid_request_error","message":"invalid tool schema"}}',
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
        maxRetries: 2,
      },
      () => {},
    ),
    (error) => error instanceof ProviderError && error.code === 'configuration',
  )
  server.close()
  assert.equal(calls, 1)
})

test('does not retry authentication errors', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":"bad key"}')
  })
  const port = server.address().port
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-wrong',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      },
      () => {},
    ),
    (error) =>
      error instanceof ProviderError && error.code === 'authentication',
  )
  server.close()
  assert.equal(calls, 1)
})
