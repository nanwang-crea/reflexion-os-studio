import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { RunRunner } from '../dist/agent/run/runner.js'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import {
  ApprovalGateway,
  PermissionGate,
} from '../dist/agent/permissions/index.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-full-')))
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function makeGate(preset, dangerActive = false) {
  return new PermissionGate({
    preset,
    hasWorkspace: true,
    approvalOverride: 'default',
    dangerActive: () => dangerActive,
  })
}

const WRITE_TOOL_CALL =
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"file.write","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'

/**
 * 跑一轮"模型请求 file.write"的 Run。onRequired(toolCallId, resolveChoice)
 * 在 approval.required 出现时回调，供测试模拟用户点选。
 */
async function runWriteOnce(options) {
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
      response.write(WRITE_TOOL_CALL)
      response.end('data: [DONE]\n\n')
      return
    }
    response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
    response.write(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    )
    response.end('data: [DONE]\n\n')
  })

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
  const approvals = new ApprovalGateway()
  const controller = new AbortController()
  try {
    const execute = new RunRunner(store).execute({
      run,
      provider: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: 'key',
        model: 'model',
      },
      buildHistory: async () => [{ role: 'user', content: 'hello' }],
      registry,
      workspaceRoot: '/tmp/p',
      gate: makeGate(options.preset, options.danger === true),
      approvals,
      settings: { maxTurns: 4 },
      controller,
      emitter: new RunEventEmitter(run.id, (event) => {
        events.push(event)
        if (
          event.type === 'approval.required' &&
          options.onRequired !== undefined
        ) {
          // 异步点选：让 request promise 先挂起再接线。
          queueMicrotask(() =>
            options.onRequired?.(event.toolCallId, (choiceId) =>
              approvals.resolveChoice(event.toolCallId, choiceId),
            ),
          )
        }
      }),
      firstAssistantMessage,
    })
    await execute
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  return { store, session, run, events, seenGrants }
}

test('workspace-full：file.write 免审批，签发 preset source 的精确 V2 grant', async () => {
  const { store, session, run, events, seenGrants } = await runWriteOnce({
    preset: 'workspace-full',
  })
  assert.equal(
    events.some((event) => event.type === 'approval.required'),
    false,
    'workspace-full run must not request approval',
  )
  assert.equal(store.runs.get(run.id).status, 'completed')
  assert.equal(seenGrants.length, 1)
  const grant = JSON.parse(seenGrants[0])
  assert.equal(grant.version, 2)
  assert.equal(grant.source, 'preset')
  assert.equal(grant.operation, 'file.write')
  assert.equal(grant.sessionId, session.id)
  assert.equal(grant.workspaceId, '/tmp/p')
  // 精确绑定：subjectDigest 覆盖 operation + 规范化 path。
  assert.match(grant.subjectDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(grant.sandbox, 'workspace-write')
  assert.equal(grant.sandboxNetwork, false)
  assert.ok(grant.expiresAt > Date.now())
  // 工具轨迹：completed 且 approvalGrantId 记录 grant（审计可见，不进事件）。
  const row = store.toolCalls.listByRun(run.id)[0]
  assert.equal(row.status, 'completed')
  const storedGrant = JSON.parse(row.approvalGrantId)
  assert.equal(storedGrant.source, 'preset')
  assert.equal(storedGrant.subjectDigest, grant.subjectDigest)
})

test('workspace-read：file.write 弹卡（V2 载荷），once 批准签发 once grant', async () => {
  const { store, run, events, seenGrants } = await runWriteOnce({
    preset: 'workspace-read',
    onRequired: (toolCallId, resolve) => resolve('allow-once'),
  })
  const required = events.find((event) => event.type === 'approval.required')
  assert.ok(required, 'must request approval')
  assert.deepEqual(required.subject, {
    kind: 'workspace-path',
    operation: 'file.write',
    path: 'a.txt',
  })
  assert.equal(required.risk, 'normal')
  assert.deepEqual(
    required.choices.map((choice) => choice.id),
    ['allow-once', 'session:file.write', 'deny'],
  )
  assert.equal(required.context.sandbox, 'workspace-write')
  assert.equal(required.context.workspaceScope, 'inside')
  assert.equal(store.runs.get(run.id).status, 'completed')
  const grant = JSON.parse(seenGrants[0])
  assert.equal(grant.source, 'once')
  const resolved = events.find((event) => event.type === 'approval.resolved')
  assert.equal(resolved.choiceId, 'allow-once')
  assert.equal(resolved.grantScope, 'once')
})

test('拒绝 choice：工具以 permission_denied 失败，不签发 grant', async () => {
  const { store, run, events, seenGrants } = await runWriteOnce({
    preset: 'workspace-read',
    onRequired: (toolCallId, resolve) => resolve('deny'),
  })
  assert.equal(
    events.some((event) => event.type === 'approval.required'),
    true,
  )
  assert.equal(store.runs.get(run.id).status, 'completed')
  assert.equal(seenGrants.length, 0)
  const row = store.toolCalls.listByRun(run.id)[0]
  assert.equal(row.status, 'failed')
  assert.equal(row.errorCode, 'permission_denied')
})

test('Danger lease 激活：内置操作跳过审批，grant source=danger-lease', async () => {
  const { store, run, events, seenGrants } = await runWriteOnce({
    preset: 'workspace-read',
    danger: true,
  })
  assert.equal(
    events.some((event) => event.type === 'approval.required'),
    false,
    'danger lease must skip routine approvals',
  )
  assert.equal(store.runs.get(run.id).status, 'completed')
  const grant = JSON.parse(seenGrants[0])
  assert.equal(grant.source, 'danger-lease')
  assert.equal(grant.sandbox, 'workspace-write')
})
