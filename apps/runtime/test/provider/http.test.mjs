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

test('openai-responses surfaces response.failed error details', async (t) => {
  const { streamChat } = await import('../../dist/provider.js')
  const fetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"upstream exploded"}}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  t.after(() => {
    globalThis.fetch = fetch
  })
  await assert.rejects(
    streamChat(
      {
        baseUrl: 'https://mock.invalid',
        apiKey: 'test',
        model: 'm',
        messages: [],
        maxRetries: 0,
        signal: new AbortController().signal,
      },
      'openai-responses',
      () => {},
    ),
    (error) => {
      assert.equal(error.code, 'provider')
      assert.match(
        error.message,
        /responses api failed \(server_error\): upstream exploded/,
      )
      return true
    },
  )
})

for (const format of ['openai-chat', 'openai-responses', 'anthropic']) {
  test(`${format} redacts a returned credential before truncating HTTP diagnostics`, async (t) => {
    const { streamChat } = await import('../../dist/provider.js')
    const credential = 'synthetic-credential-' + 'x'.repeat(320)
    const fetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: `invalid credential: ${credential}` }),
        { status: 401 },
      )
    t.after(() => {
      globalThis.fetch = fetch
    })
    await assert.rejects(
      streamChat(
        {
          baseUrl: 'https://mock.invalid',
          apiKey: credential,
          model: 'm',
          messages: [],
          maxRetries: 0,
          signal: new AbortController().signal,
        },
        format,
        () => {},
      ),
      (error) => {
        assert.equal(error.code, 'authentication')
        assert.ok(!error.message.includes('synthetic-credential-'))
        assert.match(error.message, /\[redacted\]/)
        return true
      },
    )
  })

  test(`${format} redacts transport errors before publishing retry diagnostics`, async (t) => {
    const { streamChat } = await import('../../dist/provider.js')
    const credential = 'synthetic-credential-for-retry'
    const fetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error(`transport rejected ${credential}`)
    }
    t.after(() => {
      globalThis.fetch = fetch
    })
    const controller = new AbortController()
    const retries = []
    await assert.rejects(
      streamChat(
        {
          baseUrl: 'https://mock.invalid',
          apiKey: credential,
          model: 'm',
          messages: [],
          maxRetries: 1,
          signal: controller.signal,
          onRetry: (retry) => {
            retries.push(retry)
            controller.abort()
          },
        },
        format,
        () => {},
      ),
      (error) => error.name === 'AbortError',
    )
    assert.equal(retries.length, 1)
    assert.ok(!retries[0].reason.includes(credential))
    assert.match(retries[0].reason, /\[redacted\]/)
  })
}

for (const [format, event] of [
  ['openai-chat', { choices: [{ delta: { content: 'text' } }] }],
  ['openai-responses', { type: 'response.output_text.delta', delta: 'text' }],
  [
    'anthropic',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'text' },
    },
  ],
]) {
  test(`${format} callback failures cancel and release the HTTP body`, async (t) => {
    const { streamChat } = await import('../../dist/provider.js')
    const fetch = globalThis.fetch
    let cancelled = 0
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
        )
      },
      cancel() {
        cancelled++
      },
    })
    globalThis.fetch = async () => new Response(body)
    t.after(() => {
      globalThis.fetch = fetch
    })
    const failure = new Error('consumer failed')
    await assert.rejects(
      streamChat(
        {
          baseUrl: 'https://mock.invalid',
          apiKey: 'test',
          model: 'm',
          messages: [],
          maxRetries: 0,
          signal: new AbortController().signal,
        },
        format,
        () => {
          throw failure
        },
      ),
      (error) => error === failure,
    )
    assert.equal(cancelled, 1)
    assert.equal(body.locked, false)
  })
}
