import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApprovalGateway } from '../dist/agent/permissions.js'

function emitter(runId) {
  return {
    runId,
    next: () => {},
  }
}

test('hasPendingRun tracks awaiting approvals per run', async () => {
  const gateway = new ApprovalGateway()
  const signalA = new AbortController().signal
  const signalB = new AbortController().signal
  const pendingA = gateway.request({
    toolCallId: 'a1',
    emitter: emitter('run-1'),
    operation: 'shell.execute',
    summary: 'echo a',
    signal: signalA,
    context: { sessionId: 'session-1', workspaceRoot: '/workspace/a' },
  })
  const pendingB = gateway.request({
    toolCallId: 'b1',
    emitter: emitter('run-1'),
    operation: 'file.write',
    summary: 'write x',
    signal: signalB,
    context: { sessionId: 'session-1', workspaceRoot: '/workspace/a' },
  })
  // 两个并行请求属于同一 Run:仍有一个未决时算"有 pending"。
  assert.equal(gateway.hasPendingRun('run-1'), true)
  assert.equal(gateway.resolve('a1', 'approved', 'once'), true)
  assert.equal(gateway.hasPendingRun('run-1'), true)
  assert.equal(gateway.resolve('b1', 'approved', 'once'), true)
  assert.equal(gateway.hasPendingRun('run-1'), false)
  await pendingA
  await pendingB
  assert.equal(
    gateway.hasSessionGrant('shell.execute', {
      sessionId: 'session-1',
      workspaceRoot: '/workspace/a',
    }),
    false,
  )
  const isolated = gateway.request({
    toolCallId: 'c1',
    emitter: emitter('run-3'),
    operation: 'shell.execute',
    summary: 'echo c',
    signal: new AbortController().signal,
    context: { sessionId: 'session-1', workspaceRoot: '/workspace/b' },
  })
  assert.equal(
    gateway.hasSessionGrant('shell.execute', {
      sessionId: 'session-1',
      workspaceRoot: '/workspace/b',
    }),
    false,
  )
  gateway.resolve('c1', 'approved', 'session')
  await isolated
  assert.equal(
    gateway.hasSessionGrant('shell.execute', {
      sessionId: 'session-1',
      workspaceRoot: '/workspace/b',
    }),
    true,
  )
})

test('hasPendingRun separates runs and cleans on abort', async () => {
  const gateway = new ApprovalGateway()
  const controller = new AbortController()
  const pending = gateway.request({
    toolCallId: 'a2',
    emitter: emitter('run-2'),
    operation: 'file.delete',
    summary: 'delete x',
    signal: controller.signal,
    context: { sessionId: 'session-2', workspaceRoot: '/workspace/b' },
  })
  assert.equal(gateway.hasPendingRun('run-2'), true)
  assert.equal(gateway.hasPendingRun('run-9'), false)
  controller.abort()
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  assert.equal(gateway.hasPendingRun('run-2'), false)
})
