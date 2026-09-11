import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { RunRunner } from '../dist/agent/runner.js'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { ApprovalGateway, PermissionGate } from '../dist/agent/permissions.js'

function toolCallSse(id, name, index = 0) {
  return (
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id,
                type: 'function',
                function: { name, arguments: '{}' },
              },
            ],
          },
        },
      ],
    })}\n\n` +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: [DONE]\n\n'
  )
}

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-runner-')))
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function sendSse(response, content) {
  response.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
  )
  response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
  response.end('data: [DONE]\n\n')
}

test('runner resets retry draft in order and restarts chunk sequence', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const firstAssistantMessage = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  let requests = 0
  const server = await startServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests === 1) {
      response.write('data: {"choices":[{"delta":{"content":"o1"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"o2"}}]}\n\n')
      response.end()
      return
    }
    sendSse(response, 'new')
  })
  const events = []
  try {
    await new RunRunner(store).execute({
      run,
      provider: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'key',
        model: 'model',
        maxRetries: 1,
      },
      buildHistory: async () => [{ role: 'user', content: 'hello' }],
      registry: new ToolRegistry(),
      workspaceRoot: null,
      gate: new PermissionGate('workspace', false),
      approvals: new ApprovalGateway(),
      settings: { maxTurns: 1 },
      memory: null,
      controller: new AbortController(),
      emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
      firstAssistantMessage,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  const retryingIndex = events.findIndex(
    (event) => event.type === 'run.retrying',
  )
  const resetIndex = events.findIndex((event) => event.type === 'message.reset')
  assert.notEqual(retryingIndex, -1, 'run.retrying must be emitted')
  assert.notEqual(resetIndex, -1, 'message.reset must be emitted')
  assert.equal(retryingIndex + 1, resetIndex)
  assert.equal(events[resetIndex].messageId, firstAssistantMessage.id)
  assert.equal(events[retryingIndex].attempt, 1)
  assert.equal(events[retryingIndex].maxRetries, 1)
  assert.equal(events[retryingIndex].waitMs, 1000)

  const deltas = events.filter((event) => event.type === 'message.delta')
  assert.deepEqual(
    deltas.map((event) => [event.chunkSeq, event.delta]),
    [
      [0, 'o1'],
      [1, 'o2'],
      [0, 'new'],
    ],
  )
  assert.equal(
    store.messages
      .listBySession(session.id)
      .find((message) => message.id === firstAssistantMessage.id).content,
    'new',
  )
})

test('tool budget rejects the whole batch and fails the run immediately', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const firstAssistantMessage = store.messages.create({
    sessionId: session.id,
    runId: run.id,
    role: 'assistant',
    content: '',
    status: 'pending',
  })
  let requests = 0
  const registry = new ToolRegistry()
  let executed = 0
  registry.register({
    name: 'get_current_time',
    description: 'probe',
    parameters: { type: 'object', properties: {} },
    execution: { effect: 'pure' },
    execute: () => {
      executed += 1
      return Promise.resolve({ content: 'ok', isError: false })
    },
  })
  // 第一轮：2 个工具调用（预算 3）；第二轮：再发 2 个 → 整批 2 > 剩余 1。
  const server = await startServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests === 1) {
      response.write(toolCallSse('call-a', 'get_current_time', 0))
      response.write(toolCallSse('call-b', 'get_current_time', 1))
      response.end()
      return
    }
    response.write(toolCallSse('call-c', 'get_current_time', 0))
    response.write(toolCallSse('call-d', 'get_current_time', 1))
    response.end()
  })
  const events = []
  try {
    await new RunRunner(store).execute({
      run,
      provider: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'key',
        model: 'model',
        maxRetries: 1,
      },
      buildHistory: async () => [{ role: 'user', content: 'hello' }],
      registry,
      workspaceRoot: null,
      gate: new PermissionGate('workspace', false),
      approvals: new ApprovalGateway(),
      settings: { maxTurns: 3, maxToolCalls: 3 },
      memory: null,
      controller: new AbortController(),
      emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
      firstAssistantMessage,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // 第一批 2 个全部执行；第二批整批拒绝：0 个执行。
  assert.equal(executed, 2, 'first batch must run, second batch must not')
  const failed = events.find((event) => event.type === 'run.failed')
  assert.ok(failed, 'run.failed must be emitted')
  assert.equal(failed.error.code, 'tool_call_budget')
  const storedRun = store.runs.get(run.id)
  assert.equal(storedRun.status, 'failed')
  assert.equal(storedRun.errorCode, 'tool_call_budget')
  // 整批拒绝的审计语义：c/d 不执行但保留预建 ToolCall 行，由 Finalizer 取消。
  const storedCalls = store.toolCalls.listByRun(run.id)
  assert.equal(storedCalls.length, 4)
  const statusCount = { completed: 0, cancelled: 0 }
  for (const call of storedCalls) {
    statusCount[call.status] = (statusCount[call.status] ?? 0) + 1
  }
  assert.equal(statusCount.completed, 2, 'first batch completed')
  assert.equal(
    statusCount.cancelled,
    2,
    'rejected batch left as cancelled audit rows, never executed',
  )
})
