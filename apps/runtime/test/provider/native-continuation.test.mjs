import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamChat } from '../../dist/provider.js'
import { Store } from '../../dist/store/index.js'
import {
  reconstructSessionFrames,
  framesToValidatedMessages,
} from '../../dist/agent/context/context-frames.js'
import {
  framesToMessages,
  messagesToFrames,
  runAgentLoop,
  estimateFrameTokens,
  boundFramesForModel,
} from '@reflexion-os-studio/agent-core'
import {
  AnthropicMessagesRequestSchema,
  OpenAIResponsesRequestSchema,
} from '@reflexion-os-studio/contracts'

import {
  options,
  start,
  stop,
  anthropicBlocks,
  anthropicEvents,
  responsesItems,
  responsesEvents,
  withMock,
} from '../fixtures/native-thinking.mjs'

for (const [format, events, native] of [
  ['anthropic', anthropicEvents, anthropicBlocks],
  ['openai-responses', responsesEvents, responsesItems],
]) {
  test(`${format} native thinking roundtrip survives tools and restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-thinking-'))
    let store = new Store(dir)
    try {
      await withMock(events, async (bodies) => {
        const result = await streamChat(
          { ...options, messages: [{ role: 'user', content: 'task' }] },
          format,
          () => {},
        )
        const replay = result.providerContinuation
        assert.deepEqual(
          format === 'anthropic' ? replay.blocks : replay.items,
          native,
        )
        const assistant = {
          role: 'assistant',
          content: result.content,
          reasoning: result.reasoning,
          providerContinuation: replay,
          toolCalls: result.toolCalls,
        }
        const messages = [
          { role: 'user', content: 'task' },
          assistant,
          ...result.toolCalls.map((call) => ({
            role: 'tool',
            toolCallId: call.id,
            content: 'ok',
            isError: false,
          })),
        ]
        assert.deepEqual(framesToMessages(messagesToFrames(messages)), messages)
        await streamChat({ ...options, messages }, format, () => {})
        const session = store.sessions.create(null)
        store.messages.create({
          sessionId: session.id,
          runId: null,
          role: 'user',
          content: 'task',
          status: 'completed',
        })
        const run = store.runs.create({
          sessionId: session.id,
          providerId: null,
          model: options.model,
        })
        const saved = store.messages.create({
          sessionId: session.id,
          runId: run.id,
          role: 'assistant',
          content: result.content,
          status: 'completed',
        })
        store.messages.finalize(
          saved.id,
          result.content,
          'completed',
          result.reasoning,
          undefined,
          replay,
        )
        for (const call of result.toolCalls) {
          const row = store.toolCalls.create({
            runId: run.id,
            messageId: saved.id,
            toolName: call.name,
            args: JSON.parse(call.arguments),
            status: 'running',
          })
          store.toolCalls.finalize(row.id, 'completed', {
            type: 'tool_output',
            version: 1,
            content: 'ok',
            data: null,
            resourceLinks: [],
            changedFiles: [],
          })
        }
        store.close()
        store = new Store(dir)
        const history = framesToValidatedMessages(
          reconstructSessionFrames(store, session.id, 'sys'),
        )
        assert.deepEqual(history[2].providerContinuation, replay)
        await streamChat({ ...options, messages: history }, format, () => {})
        for (const body of bodies.slice(1)) {
          if (format === 'anthropic') {
            const parsed = AnthropicMessagesRequestSchema.parse(body)
            assert.deepEqual(parsed.messages[1].content, native)
            assert.deepEqual(parsed.messages[2], {
              role: 'user',
              content: result.toolCalls.map((call) => ({
                type: 'tool_result',
                tool_use_id: call.id,
                content: 'ok',
                is_error: false,
              })),
            })
          } else {
            assert.deepEqual(body.include, ['reasoning.encrypted_content'])
            assert.deepEqual(body.input.slice(1, 4), native)
            assert.equal(body.input[4].call_id, 'call_1')
            assert.equal(
              OpenAIResponsesRequestSchema.safeParse(body).success,
              true,
            )
          }
        }
        store.messages.resetPending(saved.id)
        assert.equal(
          store.messages.listBySession(session.id).at(-1).providerContinuation,
          undefined,
        )
      })
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('Responses can recover native reasoning and calls from terminal output alone', async () => {
  await withMock([responsesEvents.at(-1)], async () => {
    const result = await streamChat(
      { ...options, messages: [] },
      'openai-responses',
      () => {},
    )
    assert.deepEqual(result.providerContinuation.items, responsesItems)
    assert.equal(result.toolCalls[0].id, 'call_1')
  })
})

test('Anthropic incomplete unsigned thinking fails instead of fabricating replay', async () => {
  await withMock(
    [
      start(0, { type: 'thinking', thinking: 'thought' }),
      stop(0),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ],
    async () => {
      await assert.rejects(
        streamChat({ ...options, messages: [] }, 'anthropic', () => {}),
        (error) => error.code === 'provider_protocol',
      )
    },
  )
})

test('native blocks only replay to the same endpoint, model, and API format', async () => {
  const { toAnthropicMessages } =
    await import('../../dist/provider/anthropic/projection.js')
  const { toResponsesInput } =
    await import('../../dist/provider/openai-responses/projection.js')
  const assistant = {
    role: 'assistant',
    content: 'plain',
    toolCalls: [],
    providerContinuation: {
      apiFormat: 'anthropic',
      baseUrl: options.baseUrl,
      model: options.model,
      blocks: [anthropicBlocks[0]],
    },
  }
  for (const changed of [
    { model: 'other' },
    { baseUrl: 'https://other.invalid' },
  ]) {
    const body = toAnthropicMessages(
      { ...options, ...changed, messages: [assistant] },
      new Map(),
    )
    assert.deepEqual(body.messages[0].content, [
      { type: 'text', text: 'plain' },
    ])
  }
  assert.deepEqual(
    toResponsesInput({ ...options, messages: [assistant] }, new Map()).input,
    [{ role: 'assistant', content: 'plain' }],
  )
})

test('loop and context bounding retain opaque native data intact', async () => {
  const replay = {
    apiFormat: 'anthropic',
    baseUrl: options.baseUrl,
    model: options.model,
    blocks: [anthropicBlocks[0]],
  }
  let calls = 0
  const outcome = await runAgentLoop({
    history: [{ role: 'user', content: 'task' }],
    signal: options.signal,
    callModel: async (messages) => {
      if (calls++ === 0)
        return {
          content: 'a'.repeat(100),
          reasoning: 'thought',
          providerContinuation: replay,
          toolCalls: [],
          finishReason: 'length',
        }
      assert.deepEqual(messages[1].providerContinuation, replay)
      return {
        content: 'done',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
      }
    },
    executeToolBatch: async () => [],
  })
  const frames = messagesToFrames(outcome.messages)
  assert.ok(estimateFrameTokens(frames) > 0)
  const bounded = boundFramesForModel(frames, 1, 8)
  assert.equal(
    bounded.find((frame) => frame.providerContinuation)?.content,
    'a'.repeat(100),
  )
  assert.deepEqual(
    bounded.find((frame) => frame.providerContinuation)?.providerContinuation,
    replay,
  )
})
