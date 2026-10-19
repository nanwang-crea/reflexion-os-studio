import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contextBudgetFor,
  estimateToolTokens,
  checkRequestBudget,
} from '../../dist/agent/context/budget.js'
import { compactInRun } from '../../dist/agent/context/context.js'
import { executeModelTurn } from '../../dist/agent/run/model-turn.js'
import { provider } from './checkpoint-fixtures.mjs'

const tools = [
  {
    name: 'server/search',
    description: 'large MCP description',
    parameters: {
      type: 'object',
      description: '中'.repeat(7000),
      properties: {},
    },
  },
]

test('tool and MCP schemas consume the same input budget as history', () => {
  const config = { ...provider, contextBudget: 10000 }
  assert.ok(estimateToolTokens(tools) > 7000)
  assert.equal(
    contextBudgetFor(config, tools),
    10000 - estimateToolTokens(tools),
  )
  assert.equal(contextBudgetFor({ ...config, contextBudget: 1000 }, tools), 0)
  const history = [
    { role: 'system', content: 'rules' },
    ...Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: '中'.repeat(300),
      ...(i % 2 ? { toolCalls: [] } : {}),
    })),
    { role: 'user', content: 'keep this constraint' },
  ]
  assert.equal(compactInRun(history, config), history)
  const bounded = compactInRun(history, config, tools)
  assert.ok(bounded.length < history.length)
  assert.ok(
    bounded.some((message) => message.content === 'keep this constraint'),
  )
})

test('exceeding only the soft budget does not reject protected user content', () => {
  const messages = [
    { role: 'system', content: 's'.repeat(8000) },
    { role: 'user', content: 'u'.repeat(8000) },
  ]
  const config = {
    ...provider,
    contextBudget: 1024,
    contextWindow: 16000,
    maxTokens: 1000,
  }
  const bounded = compactInRun(messages, config)
  assert.ok(bounded.some((message) => message.content === messages[1].content))
  assert.doesNotThrow(() => checkRequestBudget(bounded, config))
  assert.doesNotThrow(() =>
    checkRequestBudget(bounded, { ...config, contextWindow: undefined }),
  )
})

test('final model-window check includes tool schemas and fails before any provider request', async (t) => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    throw Error('must not send oversized request')
  })
  const messages = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'small request' },
  ]
  const config = { ...provider, contextWindow: 8000, maxTokens: 1500 }
  assert.doesNotThrow(() => checkRequestBudget(messages, config))
  await assert.rejects(
    executeModelTurn(
      {
        provider: config,
        registry: { specs: () => tools },
        store: {},
        state: {},
        run: {},
        emitter: {},
      },
      messages,
      new AbortController().signal,
    ),
    (error) => error.code === 'configuration' && /窗口不足/.test(error.message),
  )
  assert.equal(requests, 0)
})
