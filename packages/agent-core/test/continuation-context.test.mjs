import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  boundFramesForModel,
  messagesToFrames,
  framesToMessages,
  estimateFrameTokens,
  runAgentLoop,
} from '../dist/index.js'

const task = {
  role: 'user',
  content: 'TASK_REQUIREMENT: write a complete explanation',
}
const control = {
  role: 'user',
  control: 'continuation',
  content: '[续写] 从截断点继续，不要重复已有内容',
}
const tail = 'ENDPOINT_SENTINEL'
const assistant = {
  role: 'assistant',
  content: 'a'.repeat(4000) + tail,
  toolCalls: [],
}

for (const keep of [1, 8]) {
  test(`continuation clipping preserves task and tail with recent window ${keep}`, () => {
    const history = [
      task,
      ...Array.from({ length: 12 }, () => ({
        role: 'assistant',
        content: 'older',
        toolCalls: [],
      })),
      assistant,
      control,
    ]
    const frames = boundFramesForModel(messagesToFrames(history), 128, keep)
    const messages = framesToMessages(frames)
    assert.ok(messages.some((message) => message.content === task.content))
    assert.ok(
      messages.some(
        (message) =>
          message.role === 'assistant' && message.content.endsWith(tail),
      ),
    )
    assert.deepEqual(messages.at(-1), control)
    assert.ok(estimateFrameTokens(frames) <= 128)
    assert.equal(assistant.content, 'a'.repeat(4000) + tail)
  })
}

test('repeated clipping retains the newest endpoint across continuation fragments', () => {
  const first = boundFramesForModel(
    messagesToFrames([task, assistant, control]),
    200,
  )
  const second = boundFramesForModel(
    messagesToFrames([
      ...framesToMessages(first),
      {
        role: 'assistant',
        content: 'b'.repeat(4000) + 'SECOND_ENDPOINT',
        toolCalls: [],
      },
      control,
    ]),
    128,
  )
  assert.ok(
    framesToMessages(second).some((message) =>
      message.content.endsWith('SECOND_ENDPOINT'),
    ),
  )
  assert.ok(
    framesToMessages(second).some(
      (message) => message.content === task.content,
    ),
  )
  assert.ok(estimateFrameTokens(second) <= 128)
})

test('user text beginning with continuation prefix is not a runtime control frame', () => {
  const frames = messagesToFrames([
    { role: 'user', content: '[续写] 这是用户正文' },
  ])
  assert.equal(frames[0].kind, 'user')
})

test('continuation restores the task after preceding tool rounds trimmed it', async () => {
  const seen = []
  let calls = 0
  const outcome = await runAgentLoop({
    history: [task],
    signal: new AbortController().signal,
    prepareMessages: (messages) => {
      if (calls === 1)
        return [
          { role: 'user', content: '[更早的历史已因上下文超长被截断]' },
          ...messages.filter((message) => message.content !== task.content),
        ]
      return framesToMessages(
        boundFramesForModel(messagesToFrames(messages), 128),
      )
    },
    callModel: async (messages) => {
      seen.push(structuredClone(messages))
      calls++
      if (calls === 1)
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c', name: 'probe', arguments: '{}' }],
        }
      if (calls === 2) return { ...assistant, finishReason: 'length' }
      return { content: 'done', finishReason: 'stop', toolCalls: [] }
    },
    executeToolBatch: async () => [{ content: 'ok', isError: false }],
  })
  assert.equal(outcome.status, 'completed')
  assert.ok(seen[2].some((message) => message.content === task.content))
  assert.ok(
    seen[2].some(
      (message) =>
        message.role === 'assistant' && message.content.endsWith(tail),
    ),
  )
})
