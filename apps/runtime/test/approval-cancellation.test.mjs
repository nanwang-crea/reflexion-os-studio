import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ApprovalGateway,
  buildApprovalChoices,
} from '../dist/agent/permissions/index.js'
import { RunEventEmitter } from '../dist/events.js'

function harness(notify = () => {}) {
  const gateway = new ApprovalGateway()
  const controller = new AbortController()
  const events = []
  const scope = { sessionId: 'session', workspaceRoot: '/workspace' }
  const subject = {
    kind: 'workspace-path',
    operation: 'file.read',
    path: 'readme.md',
  }
  const emitter = new RunEventEmitter('run', (event) => {
    events.push(event)
    notify(event, gateway, controller)
  })
  const request = () =>
    gateway.request({
      toolCallId: 'call',
      emitter,
      signal: controller.signal,
      scope,
      operation: 'file.read',
      summary: 'read',
      subject,
      risk: 'normal',
      context: {
        displayCwd: '/workspace',
        workspaceScope: 'inside',
        permissionPreset: 'workspace-write',
        approvalReason: 'preset-policy',
        sandbox: 'workspace-write',
        sandboxProvider: 'seatbelt',
        network: false,
        escalation: false,
        justification: null,
      },
      choices: buildApprovalChoices({
        toolName: 'file.read',
        subject,
        scope,
        sandbox: 'workspace-write',
        network: false,
        escalation: false,
      }),
    })
  return { gateway, controller, events, request, scope }
}

test('an already aborted request emits no approval card or resolution', async () => {
  const h = harness()
  h.controller.abort()
  await assert.rejects(h.request(), { name: 'AbortError' })
  assert.deepEqual(h.events, [])
  assert.equal(h.gateway.hasPendingRun('run'), false)
})

test('abort removes an announced card without granting or replaying a choice', async () => {
  const h = harness()
  const pending = h.request()
  h.controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(
    h.events.map((e) => e.type),
    ['approval.required', 'approval.resolved'],
  )
  assert.equal(h.events[1].decision, 'cancelled')
  assert.equal(h.events[1].choiceId, undefined)
  assert.equal(h.gateway.resolveChoice('call', 'allow-once'), false)
  assert.equal(
    h.gateway.hasWorkspacePathRule(h.scope, 'file.read', 'readme.md'),
    false,
  )
  assert.equal(h.gateway.hasPendingRun('run'), false)
})

for (const action of ['cancel', 'approve']) {
  test(`synchronous ${action} during announcement settles even if resolution notification throws`, async () => {
    const h = harness((event, gateway, controller) => {
      if (event.type === 'approval.required') {
        if (action === 'cancel') controller.abort()
        else assert.equal(gateway.resolveChoice('call', 'allow-once'), true)
      } else throw new Error('notifier failed')
    })
    if (action === 'cancel')
      await assert.rejects(h.request(), { name: 'AbortError' })
    else assert.equal((await h.request()).decision, 'approved')
    assert.equal(h.gateway.hasPendingRun('run'), false)
    assert.equal(h.gateway.resolveChoice('call', 'allow-once'), false)
  })
}

test('a failed announcement leaves no pending entry or abort listener', async () => {
  const h = harness(() => {
    throw new Error('announcement failed')
  })
  await assert.rejects(h.request(), /announcement failed/)
  h.controller.abort()
  assert.equal(h.gateway.hasPendingRun('run'), false)
  assert.equal(h.gateway.resolveChoice('call', 'allow-once'), false)
  assert.equal(h.events.length, 1)
})
