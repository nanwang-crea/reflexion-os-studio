import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamChat } from '../../dist/provider.js'
import { resolveOutputBudget } from '../../dist/provider/output-budget.js'
import { contextBudgetFor } from '../../dist/agent/context/context.js'
import { startServer } from '../fixtures/provider-server.mjs'

const config = { baseUrl: 'http://x', apiKey: 'test', model: 'm' }
test('Anthropic request and context reserve share the same effective default', () => {
  assert.deepEqual(resolveOutputBudget({ apiFormat: 'anthropic' }), {
    requestMaxTokens: 4096,
    outputReserve: 4096,
  })
  assert.equal(
    contextBudgetFor({
      ...config,
      apiFormat: 'anthropic',
      contextWindow: 16000,
    }),
    7904,
  )
  assert.deepEqual(
    resolveOutputBudget({ apiFormat: 'anthropic', maxTokens: 1000 }),
    { requestMaxTokens: 1000, outputReserve: 1000 },
  )
  assert.deepEqual(resolveOutputBudget({}), {
    requestMaxTokens: undefined,
    outputReserve: 4096,
  })
})

for (const reason of [
  'max_output_tokens',
  'content_filter',
  'unknown',
  undefined,
]) {
  test(`Responses incomplete preserves and classifies ${reason}`, async () => {
    const server = await startServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason },
            usage: { input_tokens: 10, output_tokens: 20 },
          },
        })}\n\n`,
      )
    })
    try {
      const request = streamChat(
        {
          ...config,
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          messages: [{ role: 'user', content: 'hi' }],
          signal: new AbortController().signal,
          maxRetries: 0,
        },
        'openai-responses',
        () => {},
      )
      if (reason === undefined || reason === 'unknown') {
        await assert.rejects(
          request,
          (error) => error.code === 'provider_protocol',
        )
      } else {
        const result = await request
        assert.equal(
          result.finishReason,
          reason === 'max_output_tokens' ? 'length' : 'content_filter',
        )
        assert.equal(result.rawStopReason, reason)
        assert.equal(result.usage.completionTokens, 20)
      }
    } finally {
      server.close()
    }
  })
}

for (const [reason, expected] of [
  ['max_tokens', 'length'],
  ['model_context_window_exceeded', 'context_limit'],
  ['refusal', 'content_filter'],
  ['unknown', null],
]) {
  test(`Anthropic classifies ${reason} without assuming completion`, async () => {
    let requestBody
    const server = await startServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        requestBody = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } })}\n\n`,
        )
      })
    })
    try {
      const promise = streamChat(
        {
          ...config,
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          messages: [{ role: 'user', content: 'hi' }],
          signal: new AbortController().signal,
          maxRetries: 0,
        },
        'anthropic',
        () => {},
      )
      if (expected === null)
        await assert.rejects(
          promise,
          (error) => error.code === 'provider_protocol',
        )
      else {
        const result = await promise
        assert.equal(result.finishReason, expected)
        assert.equal(result.rawStopReason, reason)
      }
      assert.equal(requestBody.max_tokens, 4096)
    } finally {
      server.close()
    }
  })
}
