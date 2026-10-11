import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAgentLoop } from '../dist/index.js'

const text = (content, finishReason = 'length') => ({
  content,
  finishReason,
  toolCalls: [],
})
const tool = (finishReason = 'tool_calls', arguments_ = '{}') => ({
  content: '',
  finishReason,
  toolCalls: [{ id: 'c', name: 'write', arguments: arguments_ }],
})
async function run(turns, options = {}) {
  let calls = 0
  let executed = 0
  const seen = []
  const outcome = await runAgentLoop({
    history: [{ role: 'user', content: 'task' }],
    signal: new AbortController().signal,
    callModel: async (messages) => {
      seen.push(structuredClone(messages))
      calls++
      return turns.shift()
    },
    executeToolBatch: async (requests) => {
      executed += requests.length
      return requests.map(() => ({ content: 'done', isError: false }))
    },
    ...options,
  })
  return { outcome, calls, executed, seen }
}

test('normal tool rounds reset consecutive text continuation allowance', async () => {
  const { outcome, executed } = await run(
    [text('a'), tool(), text('b'), tool(), text('c'), text('d', 'stop')],
    { maxContinuationTurns: 1 },
  )
  assert.equal(outcome.status, 'completed')
  assert.equal(executed, 2)
})

test('text continuations obey maxTurns and preserve the last fragment', async () => {
  const { outcome, calls } = await run([text('a'), text('b'), text('c')], {
    maxTurns: 2,
  })
  assert.equal(outcome.reason, 'max_turns')
  assert.equal(calls, 2)
  assert.equal(
    outcome.messages.filter((m) => m.role === 'assistant').at(-1).content,
    'b',
  )
})

test('continuation allowance exhaustion preserves the final fragment', async () => {
  const { outcome } = await run([text('a')], { maxContinuationTurns: 0 })
  assert.equal(outcome.reason, 'output_truncated')
  assert.equal(outcome.messages.at(-1).content, 'a')
})

test('fully empty truncation stops without continuation', async () => {
  const { outcome, calls } = await run([{ ...text('  '), reasoning: '  ' }])
  assert.equal(outcome.reason, 'output_empty')
  assert.equal(calls, 1)
})

test('reasoning-only truncation recovers without sending empty assistant or raw thinking', async () => {
  const recoveries = []
  const { outcome, calls, seen } = await run(
    [{ ...text(''), reasoning: 'private thinking' }, text('answer', 'stop')],
    { onRecovery: (recovery) => recoveries.push(recovery) },
  )
  assert.equal(outcome.status, 'completed')
  assert.equal(calls, 2)
  assert.deepEqual(recoveries, [{ kind: 'reasoning', attempt: 1 }])
  assert.equal(
    seen[1].some((m) => m.role === 'assistant'),
    false,
  )
  assert.equal(JSON.stringify(seen[1]).includes('private thinking'), false)
  assert.equal(seen[1].at(-1).control, 'continuation')
  assert.match(seen[1].at(-1).content, /尚未生成正文/)
})

test('repeated reasoning-only truncation uses the existing bounded allowance', async () => {
  const { outcome, calls } = await run(
    Array.from({ length: 3 }, () => ({ ...text(''), reasoning: 'thinking' })),
  )
  assert.equal(outcome.reason, 'output_truncated')
  assert.equal(calls, 3)
})

test('reasoning recovery can be disabled and obeys maxTurns', async () => {
  for (const [options, reason] of [
    [{ maxContinuationTurns: 0 }, 'output_truncated'],
    [{ maxTurns: 1 }, 'max_turns'],
  ]) {
    const { outcome, calls } = await run(
      [{ ...text(''), reasoning: 'thinking' }],
      options,
    )
    assert.equal(outcome.reason, reason)
    assert.equal(calls, 1)
  }
})

test('reasoning and text truncations share allowance and tools reset it', async () => {
  const thinking = () => ({ ...text(''), reasoning: 'thinking' })
  const limited = await run([thinking(), text('partial')], {
    maxContinuationTurns: 1,
  })
  assert.equal(limited.outcome.reason, 'output_truncated')
  const recovered = await run(
    [thinking(), tool(), thinking(), text('answer', 'stop')],
    { maxContinuationTurns: 1 },
  )
  assert.equal(recovered.outcome.status, 'completed')
  assert.equal(recovered.executed, 1)
})

test('truncated tool batch retries once without executing or replaying prior tools', async () => {
  const { outcome, executed, seen } = await run([
    tool(),
    tool('length', '{'),
    tool(),
    text('done', 'stop'),
  ])
  assert.equal(outcome.status, 'completed')
  assert.equal(executed, 2)
  assert.equal(seen[2].filter((m) => m.role === 'tool').length, 1)
  assert.equal(
    seen[2].filter((m) => m.role === 'assistant' && m.toolCalls.length).length,
    1,
  )
})

test('mixed truncated tool output never executes, retries are bounded', async () => {
  const { outcome, calls, executed } = await run([
    { ...tool('length', '{'), content: 'partial' },
    tool('length', '{}'),
  ])
  assert.equal(outcome.reason, 'tool_output_truncated')
  assert.equal(calls, 2)
  assert.equal(executed, 0)
})

test('tool recovery obeys maxTurns', async () => {
  const { outcome, calls, executed } = await run([tool('length', '{')], {
    maxTurns: 1,
  })
  assert.equal(outcome.reason, 'max_turns')
  assert.equal(calls, 1)
  assert.equal(executed, 0)
})

test('context limit does not become a text continuation', async () => {
  const { outcome, calls } = await run([text('partial', 'context_limit')])
  assert.equal(outcome.reason, 'context_limit')
  assert.equal(calls, 1)
})

test('failed tools receive action-oriented reflection and ordinary stop remains final', async () => {
  let call = 0
  let reflection
  const outcome = await runAgentLoop({
    history: [{ role: 'user', content: 'implement' }],
    signal: new AbortController().signal,
    callModel: async (messages) => {
      call++
      if (call === 1)
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'a', name: 'edit', arguments: '{}' },
            { id: 'b', name: 'edit', arguments: '{}' },
          ],
        }
      reflection = messages.find((m) => m.control === 'reflection')?.content
      return { content: 'done', finishReason: 'stop', toolCalls: [] }
    },
    executeToolBatch: async (requests) =>
      requests.map(() => ({ content: 'mismatch', isError: true })),
  })
  assert.ok(reflection.includes('继续执行'))
  assert.ok(reflection.includes('原因不明时先验证'))
  assert.equal(outcome.status, 'completed')
  assert.equal(call, 2)
})
