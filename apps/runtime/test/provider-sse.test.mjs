import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { ProviderError, streamChatCompletion } from '../dist/provider.js'

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function sseBody() {
  const lines = [
    'data: {"choices":[{"delta":{"content":"He"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"llo"}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    '',
    'data: [DONE]',
    '',
  ]
  return lines.join('\n')
}

test('streamChatCompletion collects deltas, finish reason and usage', async () => {
  const server = await startServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions')
    assert.match(request.headers.authorization ?? '', /^Bearer sk-/)
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
  // 端口 1 几乎必然拒绝连接
  await assert.rejects(
    streamChatCompletion(
      {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'sk-test',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
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
