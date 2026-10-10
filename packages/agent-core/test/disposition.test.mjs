import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAgentLoop } from '../dist/index.js'

function userMessage(content) {
  return { role: 'user', content }
}

// ---------- W1 完成状态机：finish reason 矩阵 ----------

import { classifyModelTurn, ModelProtocolError } from '../dist/index.js'

function dispositionOf(finishReason, toolCalls) {
  return classifyModelTurn(finishReason, toolCalls)
}

test('disposition matrix: stop with no tools is final', () => {
  assert.deepEqual(dispositionOf('stop', []), { kind: 'final' })
})

test('disposition matrix: stop with tool calls is protocol error', () => {
  const disposition = dispositionOf('stop', [
    { id: 'c1', name: 'clock', arguments: '{}' },
  ])
  assert.equal(disposition.kind, 'protocol_error')
})

test('disposition matrix: tool_calls with no tools is protocol error', () => {
  assert.equal(dispositionOf('tool_calls', []).kind, 'protocol_error')
})

test('disposition matrix: tool_calls with complete tools is tools', () => {
  assert.deepEqual(
    dispositionOf('tool_calls', [
      { id: 'c1', name: 'clock', arguments: '{"tz":"UTC"}' },
    ]),
    { kind: 'tools' },
  )
})

test('disposition matrix: empty arguments text is a complete call', () => {
  assert.deepEqual(
    dispositionOf('tool_calls', [{ id: 'c1', name: 'clock', arguments: '' }]),
    { kind: 'tools' },
  )
})

test('disposition matrix: incomplete JSON arguments is protocol error', () => {
  const disposition = dispositionOf('tool_calls', [
    { id: 'c1', name: 'echo', arguments: '{"text":' },
  ])
  assert.equal(disposition.kind, 'protocol_error')
})

test('disposition matrix: duplicate tool call id is protocol error', () => {
  const disposition = dispositionOf('tool_calls', [
    { id: 'c1', name: 'echo', arguments: '{}' },
    { id: 'c1', name: 'echo', arguments: '{}' },
  ])
  assert.equal(disposition.kind, 'protocol_error')
})

test('disposition matrix: empty id or name is protocol error', () => {
  assert.equal(
    dispositionOf('tool_calls', [{ id: '', name: 'echo', arguments: '{}' }])
      .kind,
    'protocol_error',
  )
  assert.equal(
    dispositionOf('tool_calls', [{ id: 'c1', name: '', arguments: '{}' }]).kind,
    'protocol_error',
  )
})

test('disposition matrix: length with tools is a recoverable tool truncation', () => {
  assert.deepEqual(dispositionOf('length', []), { kind: 'truncated' })
  assert.equal(
    dispositionOf('length', [{ id: 'c1', name: 'clock', arguments: '{}' }])
      .kind,
    'tool_truncated',
  )
})

test('disposition matrix: content_filter with no tools is blocked', () => {
  assert.deepEqual(dispositionOf('content_filter', []), {
    kind: 'blocked',
    reason: 'content_filtered',
  })
  assert.equal(
    dispositionOf('content_filter', [
      { id: 'c1', name: 'clock', arguments: '{}' },
    ]).kind,
    'protocol_error',
  )
})

// ---------- W1 length 续写 ----------

test('length continuation: two truncated fragments then stop completes', async () => {
  const turns = [
    { content: '第一段', finishReason: 'length', toolCalls: [] },
    { content: '第二段', finishReason: 'length', toolCalls: [] },
    { content: '结尾', finishReason: 'stop', toolCalls: [] },
  ]
  const seen = []
  const outcome = await runAgentLoop({
    history: [userMessage('写一篇长文')],
    signal: new AbortController().signal,
    callModel: async (messages) => {
      seen.push([...messages])
      return turns.shift()
    },
    executeToolBatch: () => {
      throw new Error('should not execute tools')
    },
  })
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.finalTurn.content, '结尾')
  // 片段保留在消息流中，每段后跟一条续写控制帧。
  assert.deepEqual(
    outcome.messages.map((m) => `${m.role}:${m.content}`),
    [
      'user:写一篇长文',
      'assistant:第一段',
      'user:[续写] 上一条回复因长度限制被截断。请从截断点继续输出，不要重复已有内容，也不要重新开始；完成后正常结束。',
      'assistant:第二段',
      'user:[续写] 上一条回复因长度限制被截断。请从截断点继续输出，不要重复已有内容，也不要重新开始；完成后正常结束。',
      'assistant:结尾',
    ],
  )
})

test('length continuation exhausts budget and stops with output_truncated', async () => {
  const truncated = { content: 'x', finishReason: 'length', toolCalls: [] }
  const outcome = await runAgentLoop({
    history: [userMessage('写不完的长文')],
    signal: new AbortController().signal,
    callModel: async () => truncated,
    executeToolBatch: (requests) =>
      requests.map(() => ({ content: '', isError: false })),
  })
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.reason, 'output_truncated')
  // 默认预算 2：初次 + 两次续写后第三次停止 → 3 轮。
  assert.equal(outcome.turns, 3)
})

test('content_filter stops the run without tool execution', async () => {
  const outcome = await runAgentLoop({
    history: [userMessage('违规请求')],
    signal: new AbortController().signal,
    callModel: async () => ({
      content: '无法协助',
      finishReason: 'content_filter',
      toolCalls: [],
    }),
    executeToolBatch: () => {
      throw new Error('should not execute tools')
    },
  })
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.reason, 'content_filtered')
})

test('protocol violations throw ModelProtocolError instead of completing', async () => {
  await assert.rejects(
    () =>
      runAgentLoop({
        history: [userMessage('hi')],
        signal: new AbortController().signal,
        callModel: async () => ({
          content: '看起来完成了',
          finishReason: 'stop',
          toolCalls: [{ id: 'c1', name: 'clock', arguments: '{}' }],
        }),
        executeToolBatch: (requests) =>
          requests.map(() => ({ content: '', isError: false })),
      }),
    (error) => error instanceof ModelProtocolError,
  )
})
