import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentSettingsSchema,
  AgentUnlimitedLimitSchema,
} from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'
import {
  runLimit,
  childLimit,
  limitSettingsHint,
} from '../dist/agent/run/budgets.js'
import { DelegationBudgetCoordinator } from '../dist/agent/delegation/budget.js'
import { runAgentLoop } from '@reflexion-os-studio/agent-core'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'unlimited-'))
  const store = new Store(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

test('eight explicit unlimited flags survive persistence without changing numeric defaults', (t) => {
  const store = fixture(t)
  const original = store.agentSettings.get()
  const saved = store.agentSettings.upsert({
    ...original,
    unlimitedLimits: AgentUnlimitedLimitSchema.options,
  })
  assert.deepEqual(saved.unlimitedLimits, AgentUnlimitedLimitSchema.options)
  assert.equal(saved.maxChildTotalTokens, 12000)
  for (const key of [
    'maxTurns',
    'maxRunTimeoutSec',
    'maxRunTotalTokens',
    'maxToolCalls',
    'maxContinuationTurns',
  ])
    assert.equal(runLimit(saved, key, 1), Infinity)
  for (const key of [
    'maxChildRuns',
    'maxChildTimeoutSec',
    'maxChildTotalTokens',
  ])
    assert.equal(childLimit(saved, key), null)
  assert.equal(runLimit(original, 'maxTurns', 100), 100)
  assert.equal(childLimit(original, 'maxChildRuns'), 4)
  assert.equal(childLimit(original, 'maxChildTotalTokens'), 12000)
  const defaults = store.agentSettings.upsert({
    ...original,
    maxChildRuns: null,
    maxChildTotalTokens: null,
    unlimitedLimits: [],
  })
  assert.equal(defaults.maxChildRuns, null)
  assert.equal(defaults.maxChildTotalTokens, null)
  assert.equal(childLimit(defaults, 'maxChildRuns'), 4)
  assert.equal(childLimit(defaults, 'maxChildTotalTokens'), 12000)
  assert.equal(
    AgentSettingsSchema.safeParse({
      ...original,
      unlimitedLimits: ['maxDepth'],
    }).success,
    false,
  )
  assert.equal(
    AgentSettingsSchema.safeParse({
      ...original,
      unlimitedLimits: ['maxParallelChildren'],
    }).success,
    false,
  )
})

test('unlimited cumulative children preserves the concurrency boundary', (t) => {
  const store = fixture(t)
  const settings = {
    ...store.agentSettings.get(),
    maxChildRuns: 1,
    maxParallelChildren: 1,
    unlimitedLimits: ['maxChildRuns'],
  }
  const budget = new DelegationBudgetCoordinator('root', settings)
  for (let i = 0; i < 20; i++) budget.acquire().release()
  const lease = budget.acquire()
  assert.throws(() => budget.acquire(), /并发.*设置 → Agent 运行时/)
  lease.release()
  assert.equal(
    limitSettingsHint('Run token 总预算').includes('保存后重新发起任务'),
    true,
  )
})

test('unlimited model and continuation turns still stop on the supplied abort signal', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(
    runAgentLoop({
      history: [{ role: 'user', content: 'continue' }],
      signal: controller.signal,
      maxTurns: Infinity,
      maxContinuationTurns: Infinity,
      callModel: async () => {
        if (++calls === 5) controller.abort()
        return {
          content: 'partial',
          reasoning: '',
          toolCalls: [],
          finishReason: 'length',
        }
      },
      executeToolBatch: async () => [],
    }),
    { name: 'AbortError' },
  )
  assert.equal(calls, 5)
})

test('the real runner bypasses opted-out time/token/turn/tool/continuation budgets', async (t) => {
  const { createServer } = await import('node:http')
  const { ToolRegistry } = await import('@reflexion-os-studio/agent-core')
  const { RunRunner } = await import('../dist/agent/run/runner.js')
  const { RunEventEmitter } = await import('../dist/events.js')
  const { PermissionGate, ApprovalGateway } =
    await import('../dist/agent/permissions/index.js')
  const store = fixture(t)
  const session = store.sessions.create(null)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'synthetic',
    model: 'synthetic',
  })
  const firstAssistantMessage = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  let requests = 0,
    executed = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const tools = [0, 1].map((index) => ({
      index,
      id: `call-${index}`,
      type: 'function',
      function: { name: 'get_current_time', arguments: '{}' },
    }))
    const delta =
      requests === 2
        ? { tool_calls: tools }
        : { content: requests === 1 ? 'partial' : 'done' }
    setTimeout(() => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: requests === 1 ? 'length' : requests === 2 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 600, completion_tokens: 600 } })}\n\n`,
      )
      response.end('data: [DONE]\n\n')
    }, 30)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const registry = new ToolRegistry()
  registry.register({
    name: 'get_current_time',
    description: 'synthetic',
    parameters: { type: 'object', properties: {} },
    execution: { effect: 'pure' },
    execute: async () => {
      executed++
      return { content: 'ok', isError: false }
    },
  })
  const events = []
  await new RunRunner(store).execute({
    run,
    firstAssistantMessage,
    registry,
    workspaceRoot: null,
    provider: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: 'synthetic',
      model: 'synthetic',
      maxRetries: 0,
    },
    buildHistory: async () => [{ role: 'user', content: 'continue' }],
    gate: new PermissionGate({
      preset: 'workspace-read',
      hasWorkspace: false,
      approvalOverride: 'default',
      dangerActive: () => false,
    }),
    approvals: new ApprovalGateway(),
    controller: new AbortController(),
    emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
    settings: {
      ...store.agentSettings.get(),
      maxTurns: 1,
      maxContinuationTurns: 0,
      maxToolCalls: 1,
      maxRunTimeoutSec: 10,
      maxRunTotalTokens: 1000,
      unlimitedLimits: AgentUnlimitedLimitSchema.options,
    },
  })
  assert.equal(requests, 3)
  assert.equal(executed, 2)
  assert.equal(store.runs.get(run.id).status, 'completed')
  assert.equal(
    events.some((event) => event.type === 'run.failed'),
    false,
  )
})
