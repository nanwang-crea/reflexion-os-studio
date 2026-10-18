import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamChat } from '../../dist/provider.js'
import { startServer } from '../fixtures/provider-server.mjs'

const protocols = {
  'openai-chat': {
    delta: { choices: [{ delta: { content: 'x' } }] },
    end: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  },
  'openai-responses': {
    delta: { type: 'response.output_text.delta', delta: 'x' },
    end: 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  },
  anthropic: {
    delta: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'x' },
    },
    end: 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
  },
}

for (const [format, frames] of Object.entries(protocols)) {
  test(`${format}: active output can outlive the idle timeout`, async () => {
    let calls = 0
    const server = await startServer((request, response) => {
      calls++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify(frames.delta)}\n\n`)
      let count = 0
      const timer = setInterval(() => {
        response.write(`data: ${JSON.stringify(frames.delta)}\n\n`)
        if (++count === 5) {
          clearInterval(timer)
          response.end(frames.end)
        }
      }, 30)
      response.on('close', () => clearInterval(timer))
    })
    try {
      const result = await streamChat(
        {
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          apiKey: 'test',
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
          signal: new AbortController().signal,
          timeoutMs: 100,
          maxRetries: 0,
        },
        format,
        () => {},
      )
      assert.equal(result.content, 'xxxxxx')
      assert.equal(calls, 1)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  test(`${format}: terminal events finish without waiting for socket EOF`, async () => {
    const server = await startServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify(frames.delta)}\n\n${frames.end}`)
      // Deliberately keep the HTTP response open after its protocol terminal event.
    })
    try {
      const result = await streamChat(
        {
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          apiKey: 'test',
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
          signal: new AbortController().signal,
          timeoutMs: 100,
          maxRetries: 0,
        },
        format,
        () => {},
      )
      assert.equal(result.content, 'x')
      assert.equal(result.finishReason, 'stop')
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
}

test('chat stream exposes sanitized provider errors instead of a misleading missing finish reason', async () => {
  let calls = 0
  const server = await startServer((request, response) => {
    calls++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      'data: {"error":{"code":429,"message":"busy test-stream-secret"}}\n\ndata: [DONE]\n\n',
    )
  })
  try {
    await assert.rejects(
      streamChat(
        {
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          apiKey: 'test-stream-secret',
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
          signal: new AbortController().signal,
          maxRetries: 0,
        },
        'openai-chat',
        () => {},
      ),
      (error) => {
        assert.equal(error.code, 'rate_limit')
        assert.match(error.message, /busy/)
        assert.ok(!error.message.includes('test-stream-secret'))
        return true
      },
    )
    assert.equal(calls, 1)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
