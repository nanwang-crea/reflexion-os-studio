import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { ShellExecuteParamsSchema } from '@reflexion-os-studio/contracts'
import { executeToolCall } from '../dist/agent/run/tool-executor.js'
import {
  PermissionGate,
  canonicalDigest,
} from '../dist/agent/permissions/index.js'
import {
  freshContext,
  shellRequest,
} from './fixtures/shell-permission-context.mjs'

const extra = {
  sandbox_permissions: 'require_unsandboxed',
  justification: '打包工具需要系统服务，申请本次解除沙箱',
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
for (const preset of ['workspace-read', 'workspace-write', 'workspace-full']) {
  for (const danger of [false, true]) {
    test(`unsandboxed always asks once: ${preset}, danger=${danger}`, async () => {
      const ctx = freshContext(preset, danger)
      // Unsandboxed needs no sandbox provider preflight.
      ctx.input.system = null
      ctx.input.sandboxProvider = 'none'
      const command = 'echo ' + 'long-command '.repeat(40)
      const pending = executeToolCall(
        { ...ctx.input, emitter: ctx.emitter },
        shellRequest('first', command, extra),
        new AbortController().signal,
      )
      await tick()
      const card = ctx.events.find((e) => e.type === 'approval.required')
      assert.ok(card)
      assert.equal(ctx.executed.length, 0)
      assert.equal(card.operation, 'shell.execute')
      assert.equal(card.context.sandbox, 'unsandboxed')
      assert.equal(card.context.displayCwd, join(ctx.input.workspaceRoot, '.'))
      assert.equal(card.context.network, true)
      assert.equal(card.risk, 'elevated')
      assert.equal(
        card.subject.displayCommand,
        command,
        'complete redacted command is reviewable',
      )
      assert.deepEqual(
        card.choices.map((c) => c.id),
        ['allow-once', 'deny'],
      )
      assert.match(card.choices[0].label, /解除沙箱/)
      ctx.approvals.resolveChoice(card.toolCallId, 'allow-once')
      assert.equal((await pending).isError, false)
      const grant = JSON.parse(ctx.executed[0].grant)
      assert.equal(grant.source, 'once')
      assert.equal(grant.sandbox, 'unsandboxed')
      assert.equal(grant.sandboxNetwork, true)
      assert.equal(grant.escalationRoots, undefined)
      assert.equal(
        grant.subjectDigest,
        canonicalDigest('shell.execute', [command, '.', 'unsandboxed', '1']),
      )
      const again = executeToolCall(
        { ...ctx.input, emitter: ctx.emitter },
        shellRequest('again', command, extra),
        new AbortController().signal,
      )
      await tick()
      const cards = ctx.events.filter((e) => e.type === 'approval.required')
      assert.equal(cards.length, 2, 'no session reuse or separate network card')
      ctx.approvals.resolveChoice(cards[1].toolCallId, 'deny')
      assert.equal((await again).isError, true)
      assert.equal(ctx.executed.length, 1)
    })
  }
}

test('unsandboxed invalid parameters, plan mode and cancellation never execute', async () => {
  for (const args of [
    { command: 'echo hi', sandbox_permissions: 'require_unsandboxed' },
    { command: 'echo hi', ...extra, justification: ' ' },
    { command: 'echo hi', ...extra, additional_write_roots: ['/tmp/extra'] },
    { command: 'echo hi', ...extra, prefix_rule: ['echo', 'hi'] },
  ])
    assert.equal(ShellExecuteParamsSchema.safeParse(args).success, false)
  const ctx = freshContext('workspace-full', true)
  ctx.input.gate = new PermissionGate({
    preset: 'workspace-full',
    hasWorkspace: true,
    approvalOverride: 'default',
    dangerActive: () => true,
    executionMode: () => 'plan',
  })
  const blocked = await executeToolCall(
    { ...ctx.input, emitter: ctx.emitter },
    shellRequest('plan', 'echo hi', extra),
    new AbortController().signal,
  )
  assert.equal(blocked.isError, true)
  assert.equal(
    ctx.events.some((e) => e.type === 'approval.required'),
    false,
  )
  const cancelled = freshContext('workspace-full', true)
  const controller = new AbortController()
  const pending = executeToolCall(
    { ...cancelled.input, emitter: cancelled.emitter },
    shellRequest('cancel', 'echo hi', extra),
    controller.signal,
  ).catch((error) => error)
  await tick()
  controller.abort()
  assert.equal((await pending).name, 'AbortError')
  assert.equal(cancelled.executed.length, 0)
  assert.equal(ctx.executed.length, 0)
})
