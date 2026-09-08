import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FrameError,
  boundFramesForModel,
  compactFrames,
  estimateFrameTokens,
  framesToMessages,
  messagesToFrames,
  validateModelMessages,
} from '../dist/index.js'

function userMessage(content) {
  return { role: 'user', content }
}

test('messagesToFrames keeps assistant tool calls and results atomic', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    userMessage('帮我读两个文件'),
    {
      role: 'assistant',
      content: '好的',
      toolCalls: [
        { id: 'c1', name: 'read', arguments: '{}' },
        { id: 'c2', name: 'read', arguments: '{}' },
      ],
    },
    { role: 'tool', toolCallId: 'c1', content: 'a', isError: false },
    { role: 'tool', toolCallId: 'c2', content: 'b', isError: false },
    { role: 'assistant', content: '读完了', toolCalls: [] },
  ]
  const frames = messagesToFrames(messages)
  assert.deepEqual(
    frames.map((f) => f.kind),
    ['system', 'user', 'tool_round', 'assistant_text'],
  )
  const round = frames[2]
  assert.equal(round.assistant.toolCalls.length, 2)
  assert.equal(round.results.length, 2)
  // 投影回消息序列与输入一致。
  assert.deepEqual(framesToMessages(frames), messages)
})

test('messagesToFrames throws on dangling tool result', () => {
  const messages = [
    userMessage('hi'),
    { role: 'tool', toolCallId: 'ghost', content: 'x', isError: false },
  ]
  assert.throws(() => messagesToFrames(messages), FrameError)
})

test('messagesToFrames throws on duplicate result consumption', () => {
  const messages = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: 'a', isError: false },
    { role: 'tool', toolCallId: 'c1', content: 'a-again', isError: false },
  ]
  assert.throws(() => messagesToFrames(messages), FrameError)
})

test('messagesToFrames throws on call declared without result', () => {
  const messages = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
    },
    userMessage('下一条'),
  ]
  assert.throws(() => messagesToFrames(messages), FrameError)
})

test('compactFrames never splits a tool round at the boundary', async () => {
  const toolRound = [
    {
      role: 'assistant',
      content: '读取',
      toolCalls: [{ id: 'big', name: 'read', arguments: '{}' }],
    },
    {
      role: 'tool',
      toolCallId: 'big',
      content: 'x'.repeat(3000),
      isError: false,
    },
  ]
  const frames = messagesToFrames([
    { role: 'system', content: 'sys' },
    userMessage('旧1'),
    { role: 'assistant', content: '旧2', toolCalls: [] },
    ...toolRound,
    userMessage('最新消息'),
  ])
  const { frames: compactedFrames, compacted } = await compactFrames({
    frames,
    budgetTokens: 50,
    keepRecentFrames: 2,
    summarize: async () => '旧历史摘要',
  })
  assert.equal(compacted, true)
  const projected = framesToMessages(compactedFrames)
  // keepRecentFrames=2 → 最近两个 Frame（tool_round + 最新 user）保留。
  const hasDangling = projected.some(
    (m) =>
      m.role === 'tool' || (m.role === 'assistant' && m.toolCalls.length > 0),
  )
  assert.equal(hasDangling, true, 'recent tool round must be kept intact')
  const validatorIssues = validateModelMessages(projected)
  assert.deepEqual(validatorIssues, [])
  // tool_round 完整保留：assistant + result 都在。
  assert.equal(
    projected.some((m) => m.role === 'tool' && m.toolCallId === 'big'),
    true,
  )
})

test('boundFramesForModel folds whole tool rounds without dangling results', () => {
  const frames = messagesToFrames([
    { role: 'system', content: 'sys' },
    userMessage('读文件'),
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'read', arguments: '{}' },
        { id: 'c2', name: 'read', arguments: '{}' },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'c1',
      content: 'x'.repeat(4000),
      isError: false,
    },
    {
      role: 'tool',
      toolCallId: 'c2',
      content: 'y'.repeat(4000),
      isError: false,
    },
    userMessage('继续'),
  ])
  const bounded = boundFramesForModel(frames, 2000)
  const projected = framesToMessages(bounded)
  assert.equal(
    projected.some((m) => m.role === 'tool'),
    false,
  )
  assert.ok(estimateFrameTokens(bounded) <= 2000)
  assert.deepEqual(validateModelMessages(projected), [])
})

test('validateModelMessages rejects out-of-order tool results', () => {
  const issues = validateModelMessages([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
    },
    userMessage('插队'),
    { role: 'tool', toolCallId: 'c1', content: 'late', isError: false },
  ])
  assert.equal(issues.length > 0, true)
})

test('validateModelMessages rejects duplicate call ids across turns', () => {
  const issues = validateModelMessages([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'dup', name: 'read', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'dup', content: 'a', isError: false },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'dup', name: 'read', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'dup', content: 'b', isError: false },
  ])
  assert.equal(issues.length > 0, true)
})

test('validateModelMessages accepts a well-formed sequence', () => {
  const issues = validateModelMessages([
    { role: 'system', content: 'sys' },
    userMessage('hi'),
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: 'ok', isError: false },
    { role: 'assistant', content: 'done', toolCalls: [] },
  ])
  assert.deepEqual(issues, [])
})

test('estimateFrameTokens counts tool arguments and results', () => {
  const args = JSON.stringify({ content: '很长'.repeat(100) })
  const resultText = '结果也很长'.repeat(50)
  const frames = messagesToFrames([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'file.edit', arguments: args }],
    },
    { role: 'tool', toolCallId: 'c1', content: resultText, isError: false },
  ])
  // 结果为 CJK 250 字 → 250 token；arguments 为含 ASCII 的 JSON 文本。
  // 总量必须超过纯结果文本（arguments 也被计入），且为精确可复现值。
  const total = estimateFrameTokens(frames)
  assert.equal(total > 250, true)
  assert.equal(total, estimateFrameTokens(frames))
})

test('property: random valid frame sequences round-trip without dangling refs', () => {
  // 确定性伪随机（mulberry32），保证测试可重复。
  let seed = 0x2f6e2b1
  const random = () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const messages = [{ role: 'system', content: 'sys' }]
    let callSeq = 0
    const turns = 1 + Math.floor(random() * 6)
    for (let turn = 0; turn < turns; turn += 1) {
      const withTools = random() < 0.6
      if (withTools) {
        const calls = []
        const count = 1 + Math.floor(random() * 3)
        for (let i = 0; i < count; i += 1) {
          callSeq += 1
          calls.push({
            id: `c${iteration}_${callSeq}`,
            name: 'tool',
            arguments: '{}',
          })
        }
        messages.push({
          role: 'assistant',
          content: `t${turn}`,
          toolCalls: calls,
        })
        for (const call of calls) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: 'r'.repeat(Math.floor(random() * 50)),
            isError: random() < 0.2,
          })
        }
      } else {
        messages.push({ role: 'assistant', content: `a${turn}`, toolCalls: [] })
      }
      if (random() < 0.5) messages.push(userMessage(`u${turn}`))
    }
    // 随机合法序列 → Frame → 消息：必须通过序列校验。
    const frames = messagesToFrames(messages)
    assert.deepEqual(
      validateModelMessages(framesToMessages(frames)),
      [],
      `iteration ${iteration}`,
    )
    // 随机 keepRecentFrames 边界的兜底裁剪也不产生悬空引用。
    const keep = 1 + Math.floor(random() * 6)
    const bounded = boundFramesForModel(
      frames,
      200 + Math.floor(random() * 2000),
      keep,
    )
    assert.deepEqual(
      validateModelMessages(framesToMessages(bounded)),
      [],
      `iteration ${iteration} bounded`,
    )
  }
})
