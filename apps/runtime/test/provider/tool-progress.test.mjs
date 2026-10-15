import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamChat } from '../../dist/provider.js'
import { RunEventEmitter } from '../../dist/events.js'
import { createModelActivityReporter } from '../../dist/agent/run/model-activity.js'
import { startServer } from '../fixtures/provider-server.mjs'

const event = (value) => `data: ${JSON.stringify(value)}\n\n`
const protocols = {
  'openai-chat': {
    start: event({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call',
                function: { name: 'task', arguments: '{' },
              },
            ],
          },
        },
      ],
    }),
    end:
      event({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"name":"编剧撰稿","task":"Write"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }) + 'data: [DONE]\n\n',
  },
  'openai-responses': {
    start: event({
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: 'item',
        call_id: 'call',
        name: 'task',
        arguments: '',
      },
    }),
    end:
      event({
        type: 'response.function_call_arguments.delta',
        item_id: 'item',
        delta: '{"name":"编剧撰稿","task":"Write"}',
      }) +
      event({ type: 'response.completed', response: { status: 'completed' } }),
  },
  anthropic: {
    start: event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call', name: 'task', input: {} },
    }),
    end:
      event({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"name":"编剧撰稿","task":"Write"}',
        },
      }) +
      event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) +
      event({ type: 'message_stop' }),
  },
}

for (const [format, frames] of Object.entries(protocols)) {
  test(`${format}: report preparation before the tool arguments finish`, async () => {
    let finish
    const firstProgress = Promise.withResolvers()
    const calls = []
    const server = await startServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(frames.start)
      finish = () => response.end(frames.end)
    })
    try {
      let settled = false
      const pending = streamChat(
        {
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          apiKey: 'test',
          model: 'test',
          messages: [{ role: 'user', content: 'write' }],
          tools: [
            {
              name: 'task',
              description: 'Delegate',
              parameters: { type: 'object' },
            },
          ],
          signal: new AbortController().signal,
          maxRetries: 0,
          onToolCallProgress: (call) => {
            calls.push(call)
            firstProgress.resolve()
          },
        },
        format,
        () => {},
      ).finally(() => {
        settled = true
      })
      await firstProgress.promise
      assert.equal(settled, false)
      assert.equal(calls[0].name, 'task')
      finish()
      const result = await pending
      assert.equal(result.toolCalls[0].name, 'task')
      assert.equal(JSON.parse(result.toolCalls[0].arguments).name, '编剧撰稿')
      assert.ok(calls.length >= 2)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
}

test('activity metadata is deduplicated, scoped, and never contains task arguments', () => {
  const events = []
  const reporter = createModelActivityReporter(
    new RunEventEmitter('root', (event) => events.push(event)),
    'message',
  )
  reporter.report({ id: 'first', name: 'task', arguments: '{' })
  for (let i = 0; i < 100; i++)
    reporter.report({
      id: 'first',
      name: 'task',
      arguments: '{"task":"' + 'x'.repeat(i),
    })
  assert.equal(events.length, 1)
  const argumentsText = JSON.stringify({
    name: '编剧撰稿',
    task: 'PRIVATE_TASK_BODY_NOT_FOR_STATUS',
  })
  reporter.report({ id: 'first', name: 'task', arguments: argumentsText })
  reporter.report({ id: 'first', name: 'task', arguments: argumentsText })
  assert.equal(events.length, 2)
  assert.equal(events[1].taskName, '编剧撰稿')
  assert.equal(events[1].runId, 'root')
  assert.equal(events[1].messageId, 'message')
  assert.ok(
    !JSON.stringify(events).includes('PRIVATE_TASK_BODY_NOT_FOR_STATUS'),
  )
  reporter.report({
    id: 'first',
    name: 'task',
    arguments: argumentsText.replace('编剧撰稿', '编辑审稿'),
  })
  assert.equal(events.length, 3)
  assert.equal(events[2].taskName, '编辑审稿')
  reporter.report({ id: 'second', name: 'task', arguments: '{' })
  assert.equal(events.length, 4)
  reporter.reset()
  reporter.report({ id: 'first', name: 'task', arguments: '{' })
  assert.equal(events.length, 5)
})
