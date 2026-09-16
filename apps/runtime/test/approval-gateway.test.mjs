import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ApprovalGateway,
  buildApprovalChoices,
} from '../dist/agent/permissions/index.js'

const CONTEXT = {
  displayCwd: '…/repo',
  workspaceScope: 'inside',
  sandbox: 'workspace-write',
  sandboxProvider: 'seatbelt',
  network: false,
  escalation: false,
  justification: null,
}

function harness() {
  const gateway = new ApprovalGateway()
  const events = []
  const emitter = { runId: 'run-1', next: (event) => events.push(event) }
  return { gateway, events, emitter }
}

function requestApproval(harness, input) {
  const scope = input.scope ?? {
    sessionId: 'session-1',
    workspaceRoot: '/workspace/a',
  }
  const choices = buildApprovalChoices({
    toolName: input.operation,
    subject: input.subject,
    sandbox: input.sandbox ?? 'workspace-write',
    network: input.network ?? false,
    escalation: input.escalation ?? false,
    scope,
    shell: input.shell,
  })
  const pending = harness.gateway.request({
    toolCallId: input.toolCallId,
    emitter: harness.emitter,
    operation: input.operation,
    summary: input.summary ?? `${input.operation} x`,
    subject: input.subject,
    risk: input.risk ?? 'normal',
    context: input.context ?? CONTEXT,
    choices,
    signal: input.signal ?? new AbortController().signal,
    scope,
  })
  return { pending, choices }
}

test('approval.required 下发 subject/choices；resolveChoice 只认已下发 choiceId', async () => {
  const h = harness()
  const subject = {
    kind: 'workspace-path',
    operation: 'file.read',
    path: 'docs/ROADMAP.md',
  }
  const { pending } = requestApproval(h, {
    toolCallId: 't1',
    operation: 'file.read',
    subject,
    sandbox: 'read-only',
  })
  const required = h.events[0]
  assert.equal(required.type, 'approval.required')
  assert.deepEqual(
    required.choices.map((choice) => choice.id),
    ['allow-once', 'session:file.read', 'deny'],
  )
  assert.deepEqual(required.subject, subject)
  assert.equal(required.risk, 'normal')
  // 未下发的 choice 不能落子（前端不得构造授权）。
  assert.equal(h.gateway.resolveChoice('t1', 'session:file.write'), false)
  assert.equal(h.gateway.hasPendingRun('run-1'), true)
  assert.equal(h.gateway.resolveChoice('t1', 'session:file.read'), true)
  const outcome = await pending
  assert.equal(outcome.decision, 'approved')
  assert.equal(outcome.grantScope, 'session')
  assert.equal(outcome.choiceId, 'session:file.read')
  const resolved = h.events[1]
  assert.equal(resolved.type, 'approval.resolved')
  assert.equal(resolved.choiceId, 'session:file.read')
  assert.equal(resolved.grantScope, 'session')
  // 精确 path + operation 才命中：另一文件、另一操作都不放行。
  const scope = { sessionId: 'session-1', workspaceRoot: '/workspace/a' }
  assert.equal(
    h.gateway.hasWorkspacePathRule(scope, 'file.read', 'docs/ROADMAP.md'),
    true,
  )
  assert.equal(
    h.gateway.hasWorkspacePathRule(scope, 'file.read', 'docs/OTHER.md'),
    false,
  )
  assert.equal(
    h.gateway.hasWorkspacePathRule(scope, 'file.write', 'docs/ROADMAP.md'),
    false,
  )
  assert.equal(h.gateway.hasPendingRun('run-1'), false)
})

test('file.edit 组合 choice 原子生成 read+edit 两条规则', async () => {
  const { gateway, emitter } = harness()
  const scope = { sessionId: 'session-e', workspaceRoot: '/w' }
  const subject = {
    kind: 'workspace-path',
    operation: 'file.edit',
    path: 'src/a.ts',
  }
  const choices = buildApprovalChoices({
    toolName: 'file.edit',
    subject,
    sandbox: 'workspace-write',
    network: false,
    escalation: false,
    scope,
  })
  const editChoice = choices.find((c) => c.choice.id === 'session:file.edit')
  assert.ok(editChoice)
  assert.deepEqual(
    editChoice.effect.rules.map((r) => r.operation),
    ['file.read', 'file.edit'],
  )
  const pending = gateway.request({
    toolCallId: 'e1',
    emitter,
    operation: 'file.edit',
    summary: 'edit src/a.ts',
    subject,
    risk: 'normal',
    context: CONTEXT,
    choices,
    signal: new AbortController().signal,
    scope,
  })
  gateway.resolveChoice('e1', 'session:file.edit')
  const outcome = await pending
  assert.equal(outcome.grantScope, 'session')
  assert.equal(
    gateway.hasWorkspacePathRule(scope, 'file.read', 'src/a.ts'),
    true,
  )
  assert.equal(
    gateway.hasWorkspacePathRule(scope, 'file.edit', 'src/a.ts'),
    true,
  )
})

test('delete/move 与复合 Shell 只给 once + deny（无 session choice）', () => {
  const scope = { sessionId: 'session-d', workspaceRoot: '/w' }
  const deleteChoices = buildApprovalChoices({
    toolName: 'file.delete',
    subject: {
      kind: 'workspace-path',
      operation: 'file.delete',
      path: 'x.txt',
    },
    sandbox: 'workspace-write',
    network: false,
    escalation: false,
    scope,
  })
  assert.deepEqual(
    deleteChoices.map((c) => c.choice.id),
    ['allow-once', 'deny'],
  )
  const moveChoices = buildApprovalChoices({
    toolName: 'file.move',
    subject: { kind: 'operation', operation: 'file.move' },
    sandbox: 'workspace-write',
    network: false,
    escalation: false,
    scope,
  })
  assert.deepEqual(
    moveChoices.map((c) => c.choice.id),
    ['allow-once', 'deny'],
  )
  const complexShell = buildApprovalChoices({
    toolName: 'shell.execute',
    subject: {
      kind: 'shell-command',
      operation: 'shell.execute',
      commandDigest: 'sha256:c',
      displayCommand: 'git status && rm -rf tmp',
      prefixCandidate: null,
      escalation: false,
      network: false,
    },
    sandbox: 'workspace-write',
    network: false,
    escalation: false,
    scope,
  })
  assert.deepEqual(
    complexShell.map((c) => c.choice.id),
    ['allow-once', 'deny'],
  )
})

test('简单 Shell prefix choice 生成含约束的会话规则', async () => {
  const { gateway, emitter } = harness()
  const scope = { sessionId: 'session-p', workspaceRoot: '/w' }
  const subject = {
    kind: 'shell-command',
    operation: 'shell.execute',
    commandDigest: 'sha256:p',
    displayCommand: 'pnpm test --filter runtime',
    prefixCandidate: ['pnpm', 'test'],
    escalation: false,
    network: false,
  }
  const choices = buildApprovalChoices({
    toolName: 'shell.execute',
    subject,
    sandbox: 'workspace-write',
    network: false,
    escalation: false,
    scope,
    shell: {
      cwd: 'apps/runtime',
      interpreter: 'posix-sh',
      prefix: ['pnpm', 'test'],
    },
  })
  const pending = gateway.request({
    toolCallId: 'p1',
    emitter,
    operation: 'shell.execute',
    summary: 'shell.execute: pnpm test',
    subject,
    risk: 'normal',
    context: CONTEXT,
    choices,
    signal: new AbortController().signal,
    scope,
  })
  gateway.resolveChoice('p1', 'session:shell-prefix')
  await pending
  // 同 identity（cwd/sandbox/network/interpreter）才命中；换 cwd 不复用。
  assert.equal(
    gateway.matchShellPrefixRule(scope, {
      interpreter: 'posix-sh',
      cwd: 'apps/runtime',
      tokens: ['pnpm', 'test', '--filter', 'runtime'],
      sandbox: 'workspace-write',
      network: false,
    }) !== null,
    true,
  )
  assert.equal(
    gateway.matchShellPrefixRule(scope, {
      interpreter: 'posix-sh',
      cwd: '.',
      tokens: ['pnpm', 'test'],
      sandbox: 'workspace-write',
      network: false,
    }),
    null,
  )
  assert.equal(
    gateway.matchShellPrefixRule(scope, {
      interpreter: 'posix-sh',
      cwd: 'apps/runtime',
      tokens: ['pnpm', 'test'],
      sandbox: 'read-only',
      network: false,
    }),
    null,
  )
  assert.equal(
    gateway.matchShellPrefixRule(scope, {
      interpreter: 'posix-sh',
      cwd: 'apps/runtime',
      tokens: ['pnpm', 'lint'],
      sandbox: 'workspace-write',
      network: false,
    }),
    null,
  )
})

test('escalation / network Shell 不给 prefix 会话规则', () => {
  const scope = { sessionId: 'session-x', workspaceRoot: '/w' }
  const base = {
    kind: 'shell-command',
    operation: 'shell.execute',
    commandDigest: 'sha256:x',
    displayCommand: 'git fetch',
    prefixCandidate: ['git', 'fetch'],
    escalation: false,
    network: false,
  }
  const escalated = buildApprovalChoices({
    toolName: 'shell.execute',
    subject: { ...base, escalation: true },
    sandbox: 'escalated',
    network: false,
    escalation: true,
    scope,
    shell: { cwd: '.', interpreter: 'posix-sh', prefix: ['git', 'fetch'] },
  })
  assert.deepEqual(
    escalated.map((c) => c.choice.id),
    ['allow-once', 'deny'],
  )
  const networked = buildApprovalChoices({
    toolName: 'shell.execute',
    subject: { ...base, network: true },
    sandbox: 'workspace-write',
    network: true,
    escalation: false,
    scope,
    shell: { cwd: '.', interpreter: 'posix-sh', prefix: ['git', 'fetch'] },
  })
  assert.deepEqual(
    networked.map((c) => c.choice.id),
    ['allow-once', 'deny'],
  )
})

test('MCP 动态工具保持 operation 级会话授权', async () => {
  const { gateway, emitter } = harness()
  const scope = { sessionId: 'session-m', workspaceRoot: '/w' }
  const subject = { kind: 'operation', operation: 'server/tool-a' }
  const choices = buildApprovalChoices({
    toolName: 'server/tool-a',
    subject,
    sandbox: 'read-only',
    network: false,
    escalation: false,
    scope,
  })
  assert.deepEqual(
    choices.map((c) => c.choice.id),
    ['allow-once', 'session:operation', 'deny'],
  )
  const pending = gateway.request({
    toolCallId: 'm1',
    emitter,
    operation: 'server/tool-a',
    summary: 'call',
    subject,
    risk: 'normal',
    context: CONTEXT,
    choices,
    signal: new AbortController().signal,
    scope,
  })
  gateway.resolveChoice('m1', 'session:operation')
  await pending
  assert.equal(gateway.hasSessionOperationGrant('server/tool-a', scope), true)
  assert.equal(gateway.hasSessionOperationGrant('server/tool-b', scope), false)
  assert.equal(
    gateway.hasSessionOperationGrant('server/tool-a', {
      sessionId: 'session-m',
      workspaceRoot: '/other',
    }),
    false,
  )
})

test('clearSession 清空规则、operation 授权与覆盖项（不跨会话误伤）', async () => {
  const { gateway, emitter } = harness()
  const scopeA = { sessionId: 'sa', workspaceRoot: '/w' }
  const scopeB = { sessionId: 'sb', workspaceRoot: '/w' }
  const subject = {
    kind: 'workspace-path',
    operation: 'file.read',
    path: 'a.md',
  }
  const choices = buildApprovalChoices({
    toolName: 'file.read',
    subject,
    sandbox: 'read-only',
    network: false,
    escalation: false,
    scope: scopeA,
  })
  const pending = gateway.request({
    toolCallId: 'c1',
    emitter,
    operation: 'file.read',
    summary: 'read a.md',
    subject,
    risk: 'normal',
    context: CONTEXT,
    choices,
    signal: new AbortController().signal,
    scope: scopeA,
  })
  gateway.resolveChoice('c1', 'session:file.read')
  await pending
  gateway.setApprovalOverride('sa', 'ask-everything')
  assert.equal(gateway.hasWorkspacePathRule(scopeA, 'file.read', 'a.md'), true)
  gateway.clearSession('sa')
  assert.equal(gateway.hasWorkspacePathRule(scopeA, 'file.read', 'a.md'), false)
  assert.equal(gateway.approvalOverrideFor('sa'), 'default')
  // 其它会话不受影响（本用例 scopeB 没有规则，断言查询安全）。
  assert.equal(gateway.hasWorkspacePathRule(scopeB, 'file.read', 'a.md'), false)
})

test('hasPendingRun 区分 Run 并在 abort 时清除', async () => {
  const { gateway, emitter } = harness()
  const scope = { sessionId: 'session-ab', workspaceRoot: '/w' }
  const controller = new AbortController()
  const subject = {
    kind: 'workspace-path',
    operation: 'file.delete',
    path: 'x',
  }
  const pending = gateway.request({
    toolCallId: 'ab1',
    emitter,
    operation: 'file.delete',
    summary: 'delete x',
    subject,
    risk: 'warning',
    context: CONTEXT,
    choices: buildApprovalChoices({
      toolName: 'file.delete',
      subject,
      sandbox: 'workspace-write',
      network: false,
      escalation: false,
      scope,
    }),
    signal: controller.signal,
    scope,
  })
  assert.equal(gateway.hasPendingRun('run-1'), true)
  assert.equal(gateway.hasPendingRun('run-9'), false)
  controller.abort()
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  assert.equal(gateway.hasPendingRun('run-1'), false)
})
