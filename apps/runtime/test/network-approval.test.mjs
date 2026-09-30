import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ApprovalGateway,
  buildGrantV2,
  buildNetworkChoices,
} from '../dist/agent/permissions/index.js'

const CONTEXT = {
  displayCwd: '…/repo',
  workspaceScope: 'inside',
  permissionPreset: 'workspace-write',
  approvalReason: 'preset-policy',
  sandbox: 'workspace-write',
  sandboxProvider: 'seatbelt',
  network: true,
  escalation: false,
  justification: null,
}

test('V2 grant 显式携带 subjectDigest / sandbox / sandboxNetwork 绑定', () => {
  const grant = JSON.parse(
    buildGrantV2({
      grantId: 'once:t1',
      requestId: 'r1',
      sessionId: 's1',
      workspaceRoot: '/w',
      operation: 'shell.execute',
      source: 'once',
      subjectDigest: 'sha256:abc',
      sandbox: 'workspace-write',
      sandboxNetwork: true,
    }),
  )
  assert.equal(grant.version, 2)
  assert.equal(grant.sandboxNetwork, true)
  assert.equal(grant.subjectDigest, 'sha256:abc')
  assert.ok(grant.expiresAt > Date.now())
  assert.ok(grant.expiresAt <= Date.now() + 6 * 60 * 1000)
})

test('网络卡 choices：简单命令给前缀会话规则（network=true），复合命令只 once', () => {
  const scope = { sessionId: 's-n1', workspaceRoot: '/w' }
  const simple = buildNetworkChoices({
    scope,
    sandbox: 'workspace-write',
    cwd: '.',
    interpreter: 'posix-sh',
    prefixCandidate: ['git', 'fetch'],
    displayCommand: 'git fetch origin',
  })
  assert.deepEqual(
    simple.map((spec) => spec.choice.id),
    ['allow-once', 'session:network-prefix', 'deny'],
  )
  const rule = simple[1].effect.rules[0]
  assert.equal(rule.kind, 'shell-prefix')
  assert.equal(rule.network, true, '会话网络授权必须绑定 network=true 维度')
  const compound = buildNetworkChoices({
    scope,
    sandbox: 'workspace-write',
    cwd: '.',
    interpreter: 'posix-sh',
    prefixCandidate: null,
    displayCommand: 'git fetch && curl x',
  })
  assert.deepEqual(
    compound.map((spec) => spec.choice.id),
    ['allow-once', 'deny'],
    '无可靠前缀不得创建会话网络授权',
  )
})

test('网络会话授权经网关落规则：once 不留痕、session 精确到前缀维度', async () => {
  const gateway = new ApprovalGateway()
  const emitter = { runId: 'run-n', next: () => {} }
  const scope = { sessionId: 'session-n', workspaceRoot: '/workspace/n' }
  const subject = {
    kind: 'shell-command',
    operation: 'shell.execute',
    commandDigest: 'sha256:git-fetch',
    displayCommand: 'git fetch origin',
    prefixCandidate: ['git', 'fetch'],
    escalation: false,
    network: true,
  }
  const pending = gateway.request({
    toolCallId: 'n1',
    emitter,
    operation: 'sandbox_network',
    summary: 'shell.execute: git fetch origin',
    subject,
    risk: 'elevated',
    context: CONTEXT,
    choices: buildNetworkChoices({
      scope,
      sandbox: 'workspace-write',
      cwd: '.',
      interpreter: 'posix-sh',
      prefixCandidate: ['git', 'fetch'],
      displayCommand: 'git fetch origin',
    }),
    signal: new AbortController().signal,
    scope,
  })
  gateway.resolveChoice('n1', 'session:network-prefix')
  const outcome = await pending
  assert.equal(outcome.grantScope, 'session')
  // 命中：同前缀同维度（network=true、cwd、sandbox、interpreter）。
  assert.notEqual(
    gateway.matchShellPrefixRule(scope, {
      interpreter: 'posix-sh',
      cwd: '.',
      tokens: ['git', 'fetch', 'upstream'],
      sandbox: 'workspace-write',
      network: true,
    }),
    null,
  )
  // 不命中：network=false（批准联网不放行不联网命令的反向复用）。
  assert.equal(
    gateway.matchShellPrefixRule(scope, {
      interpreter: 'posix-sh',
      cwd: '.',
      tokens: ['git', 'fetch'],
      sandbox: 'workspace-write',
      network: false,
    }),
    null,
  )
  // 不命中：无关命令 curl。
  assert.equal(
    gateway.matchShellPrefixRule(scope, {
      interpreter: 'posix-sh',
      cwd: '.',
      tokens: ['curl', 'https://example.com'],
      sandbox: 'workspace-write',
      network: true,
    }),
    null,
  )
})
