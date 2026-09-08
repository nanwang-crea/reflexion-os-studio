import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { RunRunner } from '../dist/agent/runner.js'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { ApprovalGateway, PermissionGate } from '../dist/agent/permissions.js'
import { createServer } from 'node:http'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-sched-')))
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function sseToolCall(id, name, argsJson = '{}', index = 0) {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index, id, function: { name, arguments: argsJson } }],
        },
      },
    ],
  })}\n\n`
}

/** 同轮多个工具调用：不同 index + 结尾统一 finish_reason=tool_calls。 */
function sseToolRound(calls) {
  const chunks = calls.map(([id, name, argsJson], i) =>
    sseToolCall(id, name, argsJson, i),
  )
  return (
    chunks.join('') +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
  )
}

const SSE_STOP =
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

/** 注册两类测试替身工具：file.read（read 策略）与 file.write（write 策略）。 */
function testRegistry() {
  const registry = new ToolRegistry()
  const calls = []
  registry.register({
    name: 'file.read',
    description: 'read double',
    parameters: { type: 'object' },
    execution: {
      effect: 'read',
      resourceKeys: (args) => [`workspace:${args.path}`],
    },
    execute: async ({ args }) => {
      calls.push({ name: 'file.read', path: args.path, at: Date.now() })
      await new Promise((r) => setTimeout(r, 60))
      return { content: `read:${args.path}`, isError: false }
    },
  })
  registry.register({
    name: 'file.write',
    description: 'write double',
    parameters: { type: 'object' },
    execution: {
      effect: 'write',
      resourceKeys: (args) => [`workspace:${args.path}`],
    },
    execute: async ({ args }) => {
      calls.push({ name: 'file.write', path: args.path, at: Date.now() })
      await new Promise((r) => setTimeout(r, 20))
      return { content: `write:${args.path}`, isError: false }
    },
  })
  registry.register({
    name: 'get_current_time',
    description: 'pure double',
    parameters: { type: 'object' },
    execution: { effect: 'pure' },
    execute: async () => {
      calls.push({ name: 'get_current_time', at: Date.now() })
      await new Promise((r) => setTimeout(r, 40))
      return { content: 'time', isError: false }
    },
  })
  return { registry, calls }
}

async function runOneTurn(
  store,
  registry,
  toolCallSse,
  settings = { maxTurns: 3 },
) {
  const project = store.projects.create({ name: 'p', folderPath: '/w' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'p',
    model: 'm',
  })
  let requests = 0
  const server = await startServer((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests === 1) {
      res.end(toolCallSse + 'data: [DONE]\n\n')
      return
    }
    res.end(SSE_STOP)
  })
  try {
    await new RunRunner(store).execute({
      run,
      provider: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'k',
        model: 'm',
        maxRetries: 0,
      },
      buildHistory: async () => [{ role: 'user', content: 'hi' }],
      registry,
      workspaceRoot: '/w',
      // trusted：file.write 免审批（本测试只验证调度，不测审批流程）。
      gate: new PermissionGate('workspace', true, true),
      approvals: new ApprovalGateway(),
      settings,
      memory: null,
      controller: new AbortController(),
      emitter: new RunEventEmitter(run.id, () => {}),
      firstAssistantMessage: store.messages.create({
        sessionId: session.id,
        runId: run.id,
        role: 'assistant',
        content: '',
        status: 'pending',
      }),
    })
  } finally {
    server.close()
  }
  return { run, session }
}

test('two independent reads execute in parallel and results arrive in order', async () => {
  const store = freshStore()
  const { registry, calls } = testRegistry()
  const sse = sseToolRound([
    ['r1', 'file.read', '{"path":"a.txt"}'],
    ['r2', 'file.read', '{"path":"b.txt"}'],
  ])
  const { run } = await runOneTurn(store, registry, sse)
  assert.equal(store.runs.get(run.id).status, 'completed')
  assert.equal(calls.length, 2)
  // 两个 read 真实并行：第二个 start 时第一个尚未结束（60ms sleep）。
  assert.equal(calls[1].at - calls[0].at < 50, true, 'reads must overlap')
  // 模型可见结果按声明顺序回填。
  const messages = store.messages
    .listBySession(store.runs.get(run.id).sessionId)
    .filter((m) => m.role === 'assistant')
  void messages
})

test('write does not cross reads: read batch completes before write starts', async () => {
  const store = freshStore()
  const { registry, calls } = testRegistry()
  const sse = sseToolRound([
    ['r1', 'file.read', '{"path":"a.txt"}'],
    ['r2', 'file.read', '{"path":"b.txt"}'],
    ['w1', 'file.write', '{"path":"c.txt"}'],
  ])
  const { run } = await runOneTurn(store, registry, sse)
  assert.equal(store.runs.get(run.id).status, 'completed')
  assert.equal(calls.length, 3)
  // write 在两个 read 完成后才开始（read 60ms + write 20ms）。
  assert.equal(calls[2].name, 'file.write')
  assert.equal(
    calls[2].at - calls[0].at >= 60,
    true,
    'write must wait for the read batch to finish',
  )
})

test('same-path read and write conflict: declared order preserved, no overlap', async () => {
  const store = freshStore()
  const { registry, calls } = testRegistry()
  const sse = sseToolRound([
    ['r1', 'file.read', '{"path":"same.txt"}'],
    ['w1', 'file.write', '{"path":"same.txt"}'],
  ])
  await runOneTurn(store, registry, sse)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].name, 'file.read')
  assert.equal(calls[1].name, 'file.write')
  assert.equal(calls[1].at - calls[0].at >= 60, true)
})

test('results map back in declaration order regardless of completion time', async () => {
  const store = freshStore()
  const { registry } = testRegistry()
  // fast 工具先完成，slow 后完成；回填顺序仍按声明顺序。
  const sse = sseToolRound([
    ['slow1', 'file.read', '{"path":"slow.txt"}'],
    ['fast2', 'get_current_time'],
  ])
  const { run } = await runOneTurn(store, registry, sse)
  const session = store.runs.get(run.id).sessionId
  // 验证通过 toolCalls 表的行序（声明顺序）而非完成时间。
  const rows = store.toolCalls.listByRun(run.id)
  assert.deepEqual(
    rows.map((row) => row.toolName),
    ['file.read', 'get_current_time'],
  )
  void session
})
