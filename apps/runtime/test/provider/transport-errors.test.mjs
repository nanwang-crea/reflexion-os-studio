import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeTransportFailure } from '../../dist/provider/transport-error.js'
import { streamChat } from '../../dist/provider.js'

const context = (overrides = {}) => ({
  phase: 'stream',
  receivedData: true,
  retries: 2,
  maxRetries: 5,
  signal: new AbortController().signal,
  apiKey: 'synthetic-secret',
  ...overrides,
})

test('transport diagnostics traverse bounded, cyclic and aggregate causes safely', () => {
  const socket = Object.assign(
    new Error('private socket details synthetic-secret'),
    {
      code: 'UND_ERR_SOCKET',
    },
  )
  const error = new AggregateError([socket], 'terminated')
  socket.cause = error
  const failure = describeTransportFailure(error, context())
  assert.equal(failure.code, 'network')
  assert.match(failure.message, /UND_ERR_SOCKET/)
  assert.match(failure.message, /已收到部分响应数据/)
  assert.match(failure.message, /已重试 2\/5 次（共 3 次请求）/)
  assert.ok(!failure.message.includes('synthetic-secret'))
  assert.ok(!failure.message.includes('private socket'))
})

test('transport diagnostics distinguish local idle timeout from network errors', () => {
  const controller = new AbortController()
  controller.abort(new DOMException('Provider idle timeout', 'TimeoutError'))
  const failure = describeTransportFailure(
    new DOMException('aborted', 'AbortError'),
    context({
      phase: 'request',
      signal: controller.signal,
      timeoutMs: 50,
    }),
  )
  assert.equal(failure.code, 'timeout')
  assert.match(failure.message, /尚未收到响应头/)
  assert.match(failure.message, /连续 50 毫秒/)
})

for (const [code, category] of [
  ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
  ['CERT_HAS_EXPIRED', 'network'],
  ['untrusted-code-with-private-details', 'network'],
]) {
  test(`transport diagnostics classify ${code} without exposing unknown values`, () => {
    const failure = describeTransportFailure(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('private details'), { code }),
      }),
      context(),
    )
    assert.equal(failure.code, category)
    if (code.startsWith('untrusted')) assert.ok(!failure.message.includes(code))
    else assert.ok(failure.message.includes(code))
  })
}

for (const format of ['openai-chat', 'openai-responses', 'anthropic']) {
  test(`${format} reports nested request failures and actual retry count`, async (t) => {
    const originalFetch = globalThis.fetch
    t.after(() => {
      globalThis.fetch = originalFetch
    })
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('internal detail'), {
          code: 'ENOTFOUND',
        }),
      })
    }
    await assert.rejects(
      streamChat(
        {
          baseUrl: 'https://mock.invalid',
          apiKey: 'synthetic-secret',
          model: 'm',
          messages: [],
          maxRetries: 0,
          signal: new AbortController().signal,
        },
        format,
        () => {},
      ),
      (error) => {
        assert.equal(error.code, 'network')
        assert.match(error.message, /ENOTFOUND：域名解析失败/)
        assert.match(error.message, /尚未收到响应头/)
        assert.match(error.message, /已重试 0\/0 次（共 1 次请求）/)
        return true
      },
    )
  })

  test(`${format} reports stream interruption after receiving data`, async (t) => {
    const originalFetch = globalThis.fetch
    t.after(() => {
      globalThis.fetch = originalFetch
    })
    globalThis.fetch = async () => {
      let reads = 0
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (reads++ === 0)
              controller.enqueue(new TextEncoder().encode(': ping\n\n'))
            else
              controller.error(
                new TypeError('terminated', {
                  cause: Object.assign(new Error('socket closed'), {
                    code: 'ECONNRESET',
                  }),
                }),
              )
          },
        }),
      )
    }
    await assert.rejects(
      streamChat(
        {
          baseUrl: 'https://mock.invalid',
          apiKey: 'synthetic-secret',
          model: 'm',
          messages: [],
          maxRetries: 0,
          signal: new AbortController().signal,
        },
        format,
        () => {},
      ),
      (error) => {
        assert.match(error.message, /读取响应流失败（已收到部分响应数据）/)
        assert.match(error.message, /ECONNRESET：连接被重置/)
        return true
      },
    )
  })
}
