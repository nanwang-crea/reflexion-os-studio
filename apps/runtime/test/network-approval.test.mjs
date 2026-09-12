import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ApprovalGateway,
  buildOnceGrant,
  buildSessionGrant,
} from '../dist/agent/permissions.js'

function emitter(runId) {
  return { runId, next: () => {} }
}

test('grant builders carry sandboxNetwork declaration', () => {
  const once = JSON.parse(
    buildOnceGrant({
      grantId: 'g1',
      requestId: 'r1',
      sessionId: 's1',
      workspaceRoot: '/w',
      operation: 'shell.execute',
      sandboxNetwork: true,
    }),
  )
  assert.equal(once.sandboxNetwork, true)
  const session = JSON.parse(
    buildSessionGrant({
      grantId: 'session:shell.execute',
      requestId: 'r2',
      sessionId: 's1',
      workspaceRoot: '/w',
      operation: 'shell.execute',
    }),
  )
  assert.equal(session.sandboxNetwork, false)
})

test('sandbox_network session grant is independent from shell.execute', async () => {
  const gateway = new ApprovalGateway()
  const context = { sessionId: 'session-n', workspaceRoot: '/workspace/n' }
  const pending = gateway.request({
    toolCallId: 'n1',
    emitter: emitter('run-n'),
    operation: 'sandbox_network',
    summary: 'npm install',
    signal: new AbortController().signal,
    context,
  })
  gateway.resolve('n1', 'approved', 'session')
  await pending
  assert.equal(gateway.hasSessionGrant('sandbox_network', context), true)
  assert.equal(gateway.hasSessionGrant('shell.execute', context), false)
})
