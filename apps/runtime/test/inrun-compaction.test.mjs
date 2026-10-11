import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactInRun } from '../dist/agent/context/context.js'

function provider(extra = {}) {
  return {
    baseUrl: 'http://provider.invalid/v1',
    apiKey: 'sk-test',
    model: 'mock-model',
    ...extra,
  }
}

/** 构造超预算历史:系统 + 若干大消息 + 一对工具轮。 */
function oversizedHistory() {
  const messages = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 30; i += 1) {
    messages.push({
      role: 'user',
      content: `旧问题${i}` + '很多字'.repeat(900),
    })
    messages.push({ role: 'assistant', content: `旧回答${i}`, toolCalls: [] })
  }
  messages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }],
  })
  messages.push({
    role: 'tool',
    toolCallId: 'c1',
    content: 'x'.repeat(8000),
    isError: false,
  })
  messages.push({ role: 'user', content: '最近一条' })
  return messages
}

test('compactInRun deterministically bounds old rounds without provider calls', () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    throw new Error('unexpected provider call')
  }
  const result = compactInRun(oversizedHistory(), provider())
  globalThis.fetch = originalFetch

  assert.equal(requests, 0)
  const text = result.map((m) => m.content).join('\n')
  assert.ok(text.includes('更早的历史已因上下文超长被截断'))
  assert.ok(!text.includes('旧问题0'))
  assert.ok(text.includes('最近一条'))
  assert.equal(
    result.some(
      (message) => message.role === 'tool' && message.toolCallId === 'c1',
    ),
    true,
  )
  // 无悬空 tool 消息:所有 role=tool 都能匹配到保留的 assistant.toolCalls。
  const keptIds = new Set()
  for (const message of result) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) keptIds.add(call.id)
    }
  }
  for (const message of result) {
    if (message.role === 'tool') {
      assert.equal(keptIds.has(message.toolCallId), true)
    }
  }
})

test('compactInRun stays untouched when within budget', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '小事' },
  ]
  const result = compactInRun(
    messages,
    provider({ contextBudget: 1_000_000, contextWindow: 4_000_000 }),
  )
  assert.deepEqual(result, messages)
})

test('canonical task context restores plan goal and user corrections every turn', async () => {
  const { withTaskContext } =
    await import('../dist/agent/context/task-context.js')
  const history = [
    { id: 'old', role: 'user', content: 'unrelated' },
    { id: 'request', role: 'user', content: 'original request' },
    { id: 'assistant', role: 'assistant', content: 'create plan' },
    {
      id: 'correction',
      role: 'user',
      content: 'do not add a completion check',
    },
    { id: 'continue', role: 'user', content: 'continue' },
  ]
  const plan = {
    id: 'p',
    messageId: 'assistant',
    goal: 'original goal',
    steps: [{ title: 'implement', status: 'pending', note: null }],
  }
  const store = {
    plans: { getActive: () => plan },
    messages: { listBySession: () => history },
  }
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'recent', toolCalls: [] },
  ]
  const first = withTaskContext(store, 's', messages)
  const bounded = compactInRun(first, provider({ contextBudget: 1000 }))
  const task = JSON.parse(
    bounded.find((m) => m.control === 'task_context').content.split('\n')[1],
  )
  assert.equal(task.goal, 'original goal')
  assert.deepEqual(task.userInstructions, [
    'original request',
    'do not add a completion check',
    'continue',
  ])
  plan.steps[0].status = 'completed'
  const second = withTaskContext(store, 's', bounded)
  assert.equal(second.filter((m) => m.control === 'task_context').length, 1)
  assert.ok(
    second
      .find((m) => m.control === 'task_context')
      .content.includes('completed'),
  )
})
