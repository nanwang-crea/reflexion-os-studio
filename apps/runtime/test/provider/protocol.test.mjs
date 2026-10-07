import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderError, streamChatCompletion } from '../../dist/provider.js'
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

test('strict finish reason: unknown finish_reason value fails with provider_protocol', async () => {
  const server = await startServer((request, response) => {
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
        maxRetries: 0,
      },
      () => {},
    ),
    (error) =>
      error instanceof ProviderError && error.code === 'provider_protocol',
  )
  server.close()
})
