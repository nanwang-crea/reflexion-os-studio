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

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-trusted-')))
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

test('trusted run executes file.write without approval and signs trusted grant', async () => {
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
      response.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"file.write","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      )
      response.end('data: [DONE]\n\n')
      return
    }
    response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
    response.write(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    )
    response.end('data: [DONE]\n\n')
  })

  // 测试替身工具：捕获 runner 传入的 grant，替代真实 Rust 侧执行。
  const seenGrants = []
  const registry = new ToolRegistry()
  registry.register({
    name: 'file.write',
    description: 'test double',
    parameters: { type: 'object' },
    execute: async (input) => {
      seenGrants.push(input.grant)
      return { content: 'written', isError: false }
    },
  })

  const events = []
  try {
    await new RunRunner(store).execute({
      run,
      provider: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'key',
        model: 'model',
      },
      buildHistory: async () => [{ role: 'user', content: 'hello' }],
      registry,
      workspaceRoot: '/tmp/p',
      gate: new PermissionGate('workspace', true, true),
      approvals: new ApprovalGateway(),
      settings: { maxTurns: 4 },
      memory: null,
      controller: new AbortController(),
      emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
      firstAssistantMessage,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // 无审批：不弹 approval.required，Run 直接完成。
  assert.equal(
    events.some((event) => event.type === 'approval.required'),
    false,
    'trusted run must not request approval',
  )
  assert.equal(store.runs.get(run.id).status, 'completed')

  // Rust require_grant 兼容：写操作携带 trusted 会话凭据。
  assert.equal(seenGrants.length, 1)
  const grant = JSON.parse(seenGrants[0])
  assert.equal(grant.grantId, 'trusted:file.write')
  assert.equal(grant.operation, 'file.write')
  assert.equal(grant.sessionId, session.id)
  assert.equal(grant.workspaceId, '/tmp/p')
  assert.equal(grant.scope, 'session')
  // require_grant 还校验 requestId 非空与未过期：一并锁定。
  assert.equal(typeof grant.requestId, 'string')
  assert.ok(grant.requestId.length > 0)
  assert.ok(grant.expiresAt > Date.now())

  // 工具轨迹：completed 且 approvalGrantId 记录信任凭据（审计可见，存 grant JSON）。
  const row = store.toolCalls.listByRun(run.id)[0]
  assert.equal(row.status, 'completed')
  const storedGrant = JSON.parse(row.approvalGrantId)
  assert.equal(storedGrant.grantId, 'trusted:file.write')
})
