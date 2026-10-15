import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  runAgentLoop,
  messagesToFrames,
  framesToMessages,
  estimateFrameTokens,
} from '../dist/index.js'

test('tool continuation and frame roundtrip preserve reasoning verbatim', async () => {
  let calls = 0
  const reasoning = '先检查文件\n再回答'
  const outcome = await runAgentLoop({
    history: [{ role: 'user', content: '检查' }],
    signal: new AbortController().signal,
    callModel: async (messages) => {
      if (calls++ === 0) {
        return {
          content: '',
          reasoning,
          toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
          finishReason: 'tool_calls',
        }
      }
      assert.equal(messages[1].reasoning, reasoning)
      assert.equal(messages[2].role, 'tool')
      return {
        content: '完成',
        reasoning: '结果已确认',
        toolCalls: [],
        finishReason: 'stop',
      }
    },
    executeToolBatch: async () => [{ content: '文件内容', isError: false }],
  })
  const frames = messagesToFrames(outcome.messages)
  assert.deepEqual(framesToMessages(frames), outcome.messages)
  assert.equal(frames.at(-1).reasoning, '结果已确认')
  const withoutReasoning = frames.map((frame) =>
    frame.kind === 'tool_round'
      ? { ...frame, assistant: { ...frame.assistant, reasoning: '' } }
      : { ...frame, reasoning: '' },
  )
  assert.ok(estimateFrameTokens(frames) > estimateFrameTokens(withoutReasoning))
})

test('text continuation carries the truncated turn reasoning', async () => {
  let calls = 0
  await runAgentLoop({
    history: [{ role: 'user', content: '继续' }],
    signal: new AbortController().signal,
    callModel: async (messages) => {
      if (calls++ === 0) {
        return {
          content: '开头',
          reasoning: '继续分析',
          toolCalls: [],
          finishReason: 'length',
        }
      }
      assert.equal(messages[1].reasoning, '继续分析')
      return {
        content: '结尾',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
      }
    },
    executeToolBatch: async () => {
      throw new Error('unexpected tool call')
    },
  })
})

test('atomic context rejects a tool round with only a subset of its results', () => {
  assert.throws(
    () =>
      messagesToFrames([
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'first', name: 'read', arguments: '{}' },
            { id: 'second', name: 'read', arguments: '{}' },
          ],
        },
        { role: 'tool', toolCallId: 'first', content: 'ok', isError: false },
      ]),
    /missing results/,
  )
})

test('atomic context rejects results separated from their call by another user turn', () => {
  assert.throws(
    () =>
      messagesToFrames([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'first', name: 'read', arguments: '{}' }],
        },
        { role: 'user', content: 'next task' },
        { role: 'tool', toolCallId: 'first', content: 'ok', isError: false },
      ]),
    /missing|adjacent/,
  )
})

test('atomic context rejects a previously completed call id reused by a later round', () => {
  const round = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'same', name: 'read', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'same', content: 'ok', isError: false },
  ]
  assert.throws(() => messagesToFrames([...round, ...round]), /duplicate/)
})
