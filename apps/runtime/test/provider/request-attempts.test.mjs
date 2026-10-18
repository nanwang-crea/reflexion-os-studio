import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamChat } from '../../dist/provider.js'

const options = () => ({
  baseUrl: 'https://mock.invalid',
  apiKey: 'synthetic-api-secret',
  headers: [{ name: 'x-test', value: 'synthetic-header-secret' }],
  model: 'm',
  messages: [],
  maxRetries: 1,
  signal: new AbortController().signal,
})
const endings = {
  'openai-chat': [
    { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    '[DONE]',
  ],
  'openai-responses': [
    { type: 'response.output_text.delta', delta: 'done' },
    { type: 'response.completed', response: { status: 'completed' } },
  ],
  anthropic: [
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'done' },
    },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ],
}
const sse = (events) =>
  new Response(
    events
      .map(
        (event) =>
          `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`,
      )
      .join(''),
    {
      headers: { 'x-request-id': 'synthetic-request-id' },
    },
  )

for (const format of Object.keys(endings)) {
  test(`${format} sanitizes stream errors and retries only transient failures`, async (t) => {
    const original = globalThis.fetch
    t.after(() => {
      globalThis.fetch = original
    })
    let calls = 0
    const attempts = []
    const retries = []
    globalThis.fetch = async () => {
      calls++
      if (calls > 1) return sse(endings[format])
      return sse([
        {
          type: 'error',
          error: {
            type: 'overloaded_error',
            message: 'busy synthetic-api-secret synthetic-header-secret',
            extra: 'must-not-be-exposed',
          },
        },
      ])
    }
    const result = await streamChat(
      {
        ...options(),
        onRetry: (event) => retries.push(event),
        onAttempt: (attempt) => attempts.push(attempt),
      },
      format,
      () => {},
    )
    assert.equal(result.content, 'done')
    assert.equal(calls, 2)
    assert.equal(retries.length, 1)
    const finished = attempts.filter((attempt) => attempt.status !== 'running')
    assert.deepEqual(
      finished.map((attempt) => attempt.status),
      ['failed', 'completed'],
    )
    assert.deepEqual(
      finished.map((attempt) => attempt.attempt),
      [1, 2],
    )
    assert.notEqual(finished[0].id, finished[1].id)
    assert.equal(finished[0].providerRequestId, 'synthetic-request-id')
    assert.equal(finished[0].responseStatus, 200)
    assert.ok(finished[0].receivedBytes > 0)
    assert.ok(finished[0].firstDataMs >= 0)
    assert.equal(finished[0].phase, 'stream')
    const serialized = JSON.stringify({ attempts, retries })
    assert.ok(!serialized.includes('synthetic-api-secret'))
    assert.ok(!serialized.includes('synthetic-header-secret'))
    assert.ok(!serialized.includes('must-not-be-exposed'))
  })

  test(`${format} fails fast on certificate errors and records one attempt`, async (t) => {
    const original = globalThis.fetch
    t.after(() => {
      globalThis.fetch = original
    })
    const attempts = []
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('certificate'), {
          code: 'CERT_HAS_EXPIRED',
        }),
      })
    }
    await assert.rejects(
      streamChat(
        { ...options(), onAttempt: (attempt) => attempts.push(attempt) },
        format,
        () => {},
      ),
      /CERT_HAS_EXPIRED/,
    )
    assert.equal(calls, 1)
    assert.equal(attempts.at(-1).status, 'failed')
    assert.equal(attempts.at(-1).phase, 'connect')
  })

  test(`${format} does not retry authentication errors even if message says overloaded`, async (t) => {
    const original = globalThis.fetch
    t.after(() => {
      globalThis.fetch = original
    })
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return sse([
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'overloaded invalid key',
          },
        },
      ])
    }
    await assert.rejects(
      streamChat(options(), format, () => {}),
      (error) => error.code === 'authentication',
    )
    assert.equal(calls, 1)
  })
}

test('cancel during retry backoff does not create a phantom next attempt', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  const controller = new AbortController()
  const attempts = []
  await assert.rejects(
    streamChat(
      {
        ...options(),
        signal: controller.signal,
        onRetry: () => controller.abort(),
        onAttempt: (attempt) => attempts.push(attempt),
      },
      'openai-chat',
      () => {},
    ),
    (error) => error.name === 'AbortError',
  )
  assert.equal(new Set(attempts.map((attempt) => attempt.id)).size, 1)
})

test('diagnostic callback failures propagate unchanged without issuing or retrying a request', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return sse(endings['openai-chat'])
  }
  const failure = new Error('synthetic storage failure')
  await assert.rejects(
    streamChat(
      {
        ...options(),
        onAttempt: () => {
          throw failure
        },
      },
      'openai-chat',
      () => {},
    ),
    (error) => error === failure,
  )
  assert.equal(calls, 0)
})
