import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamChat } from '../../dist/provider/index.js'
import { ProviderError, streamChatCompletion } from '../../dist/provider.js'
import { parseRetryAfterMs, retryWaitMs } from '../../dist/provider/shared.js'
import { startServer, sseBody } from '../fixtures/provider-server.mjs'

test('parseRetryAfterMs accepts seconds, HTTP dates and rejects junk', () => {
  assert.equal(parseRetryAfterMs(null), null)
  assert.equal(parseRetryAfterMs(''), null)
  assert.equal(parseRetryAfterMs('soon'), null)
  assert.equal(parseRetryAfterMs('120'), 120_000)
  assert.equal(parseRetryAfterMs(' 30 '), 30_000)
  const past = new Date(Date.now() - 60_000).toUTCString()
  assert.equal(parseRetryAfterMs(past), 0)
  const future = new Date(Date.now() + 30_000).toUTCString()
  const futureMs = parseRetryAfterMs(future)
  assert.ok(futureMs !== null && futureMs > 0 && futureMs <= 30_000)
})

test('retryWaitMs takes the larger of backoff and Retry-After, capped', () => {
  assert.equal(retryWaitMs(1, null), 1000)
  assert.equal(retryWaitMs(1, 30_000), 30_000)
  assert.equal(retryWaitMs(5, 100), 16_000)
  assert.equal(retryWaitMs(1, 999_999), 120_000)
})

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

test('honors Retry-After header on 429 instead of plain backoff', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    if (calls === 1) {
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '2',
      })
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
    { attempt: 1, maxRetries: 5, reason: 'HTTP 429', waitMs: 2000 },
  ])
  assert.equal(result.content, 'Hello')
})

test('retries transient HTTP 408 request timeouts', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls += 1
    if (calls === 1) {
      response.writeHead(408, { 'content-type': 'application/json' })
      response.end('{"error":"request timeout"}')
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
    { attempt: 1, maxRetries: 5, reason: 'HTTP 408', waitMs: 1000 },
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

test('custom backoff doubles to the configured cap and preserves Retry-After', () => {
  const options = { retryBackoffInitialMs: 3000, retryBackoffMaxMs: 10000 }
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => retryWaitMs(n, null, options)),
    [3000, 6000, 10000, 10000],
  )
  assert.equal(retryWaitMs(1, 20000, options), 20000)
  assert.equal(retryWaitMs(1, 999999, options), 120000)
  assert.equal(retryWaitMs(1, null, { retryBackoffInitialMs: 5000 }), 5000)
  assert.equal(retryWaitMs(4, null, { retryBackoffMaxMs: 2000 }), 2000)
})

for (const format of ['openai-chat', 'openai-responses', 'anthropic']) {
  test(`${format} uses configured backoff and cancellation interrupts the wait`, async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end('{"error":"rate limited"}')
    })
    const controller = new AbortController()
    const retries = []
    try {
      await assert.rejects(
        streamChat(
          {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            apiKey: 'sk-test',
            model: 'mock-model',
            messages: [{ role: 'user', content: 'hi' }],
            signal: controller.signal,
            retryBackoffInitialMs: 3000,
            retryBackoffMaxMs: 9000,
            onRetry: (retry) => {
              retries.push(retry)
              controller.abort()
            },
          },
          format,
          () => {},
        ),
      )
      assert.equal(retries.length, 1)
      assert.equal(retries[0].waitMs, 3000)
    } finally {
      server.close()
    }
  })
}
