import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamChat } from '../../dist/provider.js'

const event = (value) => `data: ${JSON.stringify(value)}\n\n`
const options = {
  baseUrl: 'https://mock.invalid',
  apiKey: 'test',
  model: 'm',
  messages: [{ role: 'user', content: 'task' }],
  tools: [
    {
      name: 'get_current_time',
      description: 'time',
      parameters: { type: 'object' },
    },
  ],
  maxRetries: 0,
}
const formats = {
  'openai-chat': [
    event({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call',
                function: { name: 'get_current_time', arguments: '{}' },
              },
            ],
          },
        },
      ],
    }),
    event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ],
  'openai-responses': [
    event({
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: 'item',
        call_id: 'call',
        name: 'get_current_time',
        arguments: '{}',
      },
    }),
    event({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        id: 'item',
        call_id: 'call',
        name: 'get_current_time',
        arguments: '{}',
      },
    }),
    event({ type: 'response.completed', response: { status: 'completed' } }),
  ],
  anthropic: [
    event({ type: 'message_start', message: { usage: { input_tokens: 10 } } }) +
      event({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call',
          name: 'get_current_time',
          input: {},
        },
      }) +
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      }),
    event({ type: 'content_block_stop', index: 0 }),
    event({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 1 },
    }) + event({ type: 'message_stop' }),
  ],
}

for (const [format, chunks] of Object.entries(formats)) {
  test(`${format} reports readiness only at protocol closure, even when partial JSON parses`, async (t) => {
    const original = globalThis.fetch,
      ready = []
    let index = 0
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (index === 1) assert.equal(ready.length, 0)
            if (index < chunks.length)
              controller.enqueue(new TextEncoder().encode(chunks[index++]))
            else controller.close()
          },
        }),
      )
    t.after(() => {
      globalThis.fetch = original
    })
    const result = await streamChat(
      {
        ...options,
        signal: new AbortController().signal,
        onToolCallReady: (call) => ready.push(call),
      },
      format,
      () => {},
    )
    assert.equal(ready.length, 1)
    assert.deepEqual(ready, result.toolCalls)
  })
}
