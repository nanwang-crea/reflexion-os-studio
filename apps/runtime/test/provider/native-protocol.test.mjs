import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAgentLoop } from '@reflexion-os-studio/agent-core'
import { streamChat } from '../../dist/provider.js'
import {
  options,
  responsesItems,
  withMock,
} from '../fixtures/native-thinking.mjs'

test('Responses incomplete reasoning stream fails before losing native state', async () => {
  await withMock(
    [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ],
    async () => {
      await assert.rejects(
        streamChat({ ...options, messages: [] }, 'openai-responses', () => {}),
        (error) => error.code === 'provider_protocol',
      )
    },
  )
})

test('Responses tool ordering follows output order even when done events arrive out of order', async () => {
  const items = [
    responsesItems[0],
    responsesItems[2],
    { ...responsesItems[2], id: 'fc_2', call_id: 'call_2', arguments: '{}' },
  ]
  const events = [2, 0, 1].map((index) => ({
    type: 'response.output_item.done',
    output_index: index,
    item: items[index],
  }))
  events.push({ type: 'response.completed', response: { status: 'completed' } })
  await withMock(events, async (bodies) => {
    const first = await streamChat(
      { ...options, messages: [] },
      'openai-responses',
      () => {},
    )
    assert.deepEqual(
      first.toolCalls.map((call) => call.id),
      ['call_1', 'call_2'],
    )
    const messages = [
      {
        role: 'assistant',
        content: '',
        providerContinuation: first.providerContinuation,
        toolCalls: first.toolCalls,
      },
      ...first.toolCalls.map((call) => ({
        role: 'tool',
        toolCallId: call.id,
        content: call.id,
        isError: false,
      })),
    ]
    await streamChat({ ...options, messages }, 'openai-responses', () => {})
    assert.deepEqual(bodies[1].input.slice(0, 3), items)
    assert.deepEqual(
      bodies[1].input.slice(3).map((item) => [item.call_id, item.output]),
      [
        ['call_1', 'call_1'],
        ['call_2', 'call_2'],
      ],
    )
  })
})

test('encrypted reasoning-only truncation is replayed without a visible summary', async () => {
  const item = { ...responsesItems[0], summary: [] }
  await withMock(
    (count) =>
      count === 1
        ? [
            {
              type: 'response.incomplete',
              response: {
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                output: [item],
              },
            },
          ]
        : [
            { type: 'response.output_text.delta', delta: 'answer' },
            { type: 'response.completed', response: { status: 'completed' } },
          ],
    async (bodies) => {
      const result = await runAgentLoop({
        history: [{ role: 'user', content: 'task' }],
        signal: options.signal,
        callModel: (messages) =>
          streamChat({ ...options, messages }, 'openai-responses', () => {}),
        executeToolBatch: async () => [],
      })
      assert.equal(result.status, 'completed')
      assert.deepEqual(bodies[1].input[1], item)
      assert.equal(result.messages[1].reasoning, undefined)
      assert.deepEqual(result.messages[1].providerContinuation.items, [item])
    },
  )
})

for (const format of ['anthropic', 'openai-responses']) {
  test(`${format} native replay keeps tool aliases stable after the tool list changes`, async () => {
    const native = await import('../fixtures/native-thinking.mjs')
    const events =
      format === 'anthropic' ? native.anthropicEvents : native.responsesEvents
    await withMock(events, async (bodies) => {
      const first = await streamChat(
        {
          ...options,
          messages: [],
          tools: [
            {
              name: 'file.read',
              description: '',
              parameters: { type: 'object' },
            },
          ],
        },
        format,
        () => {},
      )
      const messages = [
        {
          role: 'assistant',
          content: first.content,
          providerContinuation: first.providerContinuation,
          toolCalls: first.toolCalls,
        },
        ...first.toolCalls.map((call) => ({
          role: 'tool',
          toolCallId: call.id,
          content: 'ok',
          isError: false,
        })),
      ]
      const second = await streamChat(
        {
          ...options,
          messages,
          tools: ['file_read', 'file.read'].map((name) => ({
            name,
            description: name,
            parameters: { type: 'object' },
          })),
        },
        format,
        () => {},
      )
      assert.deepEqual(
        bodies[1].tools.map((tool) => [tool.description, tool.name]),
        [
          ['file_read', 'file_read_2'],
          ['file.read', 'file_read'],
        ],
      )
      assert.ok(second.toolCalls.every((call) => call.name === 'file.read'))
      if (format === 'anthropic')
        assert.deepEqual(
          bodies[1].messages[0].content,
          first.providerContinuation.blocks,
        )
      else
        assert.deepEqual(
          bodies[1].input.slice(0, first.providerContinuation.items.length),
          first.providerContinuation.items,
        )
    })
  })
}
