import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@reflexion-os-studio/agent-core'
import { Store } from '../dist/store/index.js'
import { RunEventEmitter } from '../dist/events.js'
import { executeToolCall } from '../dist/agent/tool-executor.js'
import { createRunExecutionState } from '../dist/agent/run-state.js'
import {
  ApprovalGateway,
  PermissionGate,
  canonicalDigest,
} from '../dist/agent/permissions/index.js'

function freshContext(preset = 'workspace-read', danger = false) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'reflexion-shell-rule-')))
  const project = store.projects.create({ name: 'p', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const run = store.runs.create({
    sessionId: session.id,
    providerId: 'provider',
    model: 'model',
  })
  const approvals = new ApprovalGateway()
  const registry = new ToolRegistry()
  const executed = []
  registry.register({
    name: 'shell.execute',
    description: 'test double',
    parameters: { type: 'object' },
    execute: async (input) => {
      executed.push({
        command: input.args.command,
        grant: input.grant,
      })
      return { content: 'ok', isError: false }
    },
  })
  const events = []
  const gate = new PermissionGate({
    preset,
    hasWorkspace: true,
    approvalOverride: 'default',
    dangerActive: () => danger,
  })
  return {
    store,
    session,
    run,
    approvals,
    registry,
    executed,
    events,
    emitter: new RunEventEmitter(run.id, (event) => events.push(event)),
    input: {
      store,
      state: createRunExecutionState(),
      run,
      gate,
      approvals,
      registry,
      workspaceRoot: '/tmp/p',
      sandboxProvider: 'seatbelt',
    },
  }
}

function shellRequest(id, command, extra = {}) {
  return {
    id,
    name: 'shell.execute',
    arguments: JSON.stringify({ command, ...extra }),
  }
}

test('简单命令 session 前缀授权：同前缀后续免问，异前缀/换 cwd 仍问', async () => {
  const ctx = freshContext()
  const { approvals, input, emitter } = ctx

  // 第一次：git status --short → 弹卡，选择"本会话允许 git status"。
  const first = executeToolCall(
    { ...input, emitter },
    shellRequest('call-1', 'git status --short'),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const required = ctx.events.find((e) => e.type === 'approval.required')
  assert.ok(required, '第一次必须弹卡')
  assert.deepEqual(required.subject.prefixCandidate, ['git', 'status'])
  approvals.resolveChoice(required.toolCallId, 'session:shell-prefix')
  const firstResult = await first
  assert.equal(firstResult.isError, false)
  assert.equal(JSON.parse(ctx.executed[0].grant).source, 'session-rule')

  // 第二次：同前缀不同 flag → 免问自动执行，grant 重新按当前命令签发。
  const second = await executeToolCall(
    { ...input, emitter },
    shellRequest('call-2', 'git status --porcelain'),
    new AbortController().signal,
  )
  assert.equal(second.isError, false)
  assert.equal(
    ctx.events.filter((e) => e.type === 'approval.required').length,
    1,
    '同前缀不得再次弹卡',
  )
  const secondGrant = JSON.parse(ctx.executed[1].grant)
  assert.equal(secondGrant.source, 'session-rule')
  // digest 绑定完整命令：两次 grant 的 subjectDigest 必须不同（旧 grant 不复用）。
  assert.notEqual(
    secondGrant.subjectDigest,
    JSON.parse(ctx.executed[0].grant).subjectDigest,
  )

  // 第三次：换子命令（git push）→ 仍要问。
  const push = executeToolCall(
    { ...input, emitter },
    shellRequest('call-3', 'git push origin main'),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const secondRequired = ctx.events.filter(
    (e) => e.type === 'approval.required',
  )[1]
  assert.ok(secondRequired, 'git push 必须再次弹卡')
  approvals.resolveChoice(secondRequired.toolCallId, 'deny')
  await push
})

test('换 cwd 不复用前缀规则（rule identity 含工作目录）', async () => {
  const ctx = freshContext()
  const { approvals, input, emitter } = ctx
  const first = executeToolCall(
    { ...input, emitter },
    shellRequest('call-1', 'pnpm test --filter a'),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const required = ctx.events.find((e) => e.type === 'approval.required')
  approvals.resolveChoice(required.toolCallId, 'session:shell-prefix')
  await first
  // 同命令但 cwd 不同 → 必须再次弹卡。
  const other = executeToolCall(
    { ...input, emitter },
    shellRequest('call-2', 'pnpm test --filter b', { cwd: 'apps/runtime' }),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(
    ctx.events.filter((e) => e.type === 'approval.required').length,
    2,
    '换 cwd 不得复用规则',
  )
  const second = ctx.events.filter((e) => e.type === 'approval.required')[1]
  approvals.resolveChoice(second.toolCallId, 'allow-once')
  await other
})

test('复合命令只有 once + deny；选择 once 后同命令再次执行仍要问', async () => {
  const ctx = freshContext()
  const { approvals, input, emitter } = ctx
  const command = 'git status && rm -rf tmp'
  const first = executeToolCall(
    { ...input, emitter },
    shellRequest('call-1', command),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const required = ctx.events.find((e) => e.type === 'approval.required')
  assert.deepEqual(
    required.choices.map((choice) => choice.id),
    // read-only 档（workspace-read 预设）的 Shell：显式扩写 choice 存在，
    // 但没有 session 前缀菜单（复合命令不可复用）。
    ['allow-once', 'allow-once-workspace-write', 'deny'],
  )
  assert.equal(required.risk, 'warning')
  assert.equal(required.subject.prefixCandidate, null)
  approvals.resolveChoice(required.toolCallId, 'allow-once')
  await first
  // once 授权不产生任何会话规则。
  const second = executeToolCall(
    { ...input, emitter },
    shellRequest('call-2', command),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(
    ctx.events.filter((e) => e.type === 'approval.required').length,
    2,
    'once 之后必须再次询问',
  )
  const again = ctx.events.filter((e) => e.type === 'approval.required')[1]
  approvals.resolveChoice(again.toolCallId, 'deny')
  await second
})

test('read-only 档：allow-once-workspace-write 批准后 grant 按可写档重算 digest', async () => {
  const ctx = freshContext('workspace-read')
  const { approvals, input, emitter } = ctx
  const command = 'git commit -m "keep history"'
  const first = executeToolCall(
    { ...input, emitter },
    shellRequest('call-1', command),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const required = ctx.events.find((e) => e.type === 'approval.required')
  assert.equal(required.context.sandbox, 'read-only')
  approvals.resolveChoice(required.toolCallId, 'allow-once-workspace-write')
  const result = await first
  assert.equal(result.isError, false)
  const grant = JSON.parse(ctx.executed[0].grant)
  assert.equal(grant.sandbox, 'workspace-write')
  // digest 必须按最终档位重算（Rust 用 grant.sandbox 复核，旧 digest 会失配）。
  assert.equal(
    grant.subjectDigest,
    canonicalDigest('shell.execute', [command, '.', 'workspace-write', '0']),
  )
})

test('escalated：提权卡 elevated，grant 携带提权根并绑定 digest', async () => {
  const ctx = freshContext('workspace-read')
  const { approvals, input, emitter } = ctx
  const workspace = mkdtempSync(join(tmpdir(), 'reflexion-esc-'))
  const target = join(workspace, 'notes', 'out')
  const command = `cp notes.md ${target}`
  const first = executeToolCall(
    { ...input, emitter },
    shellRequest('call-1', command, {
      sandbox_permissions: 'require_escalated',
      justification: '把结果导出到用户指定的笔记目录',
    }),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const required = ctx.events.find((e) => e.type === 'approval.required')
  assert.equal(required.risk, 'elevated')
  assert.equal(required.context.escalation, true)
  assert.equal(required.subject.escalation, true)
  assert.equal(required.subject.prefixCandidate, null, '提权不给会话前缀')
  approvals.resolveChoice(required.toolCallId, 'allow-once')
  const result = await first
  assert.equal(result.isError, false)
  const grant = JSON.parse(ctx.executed[0].grant)
  assert.equal(grant.sandbox, 'escalated')
  assert.deepEqual(grant.escalationRoots, [target])
  assert.equal(
    grant.subjectDigest,
    canonicalDigest('shell.execute', [command, '.', target, 'escalated', '0']),
  )
})

test('提权缺 justification → 参数校验拒绝；敏感目标 → 不弹卡直接拒绝', async () => {
  const ctx = freshContext('workspace-read')
  const { input, emitter } = ctx
  const missing = await executeToolCall(
    { ...input, emitter },
    shellRequest('call-1', 'git config --global user.name dev', {
      sandbox_permissions: 'require_escalated',
    }),
    new AbortController().signal,
  )
  assert.equal(missing.isError, true)
  assert.equal(missing.code, 'invalid_request')

  const home = process.env.HOME ?? ''
  const ctx3 = freshContext('workspace-read')
  const denied = await executeToolCall(
    { ...ctx3.input, emitter: ctx3.emitter },
    shellRequest('call-3', `cat ${home}/.ssh/id_ed25519`, {
      sandbox_permissions: 'require_escalated',
      justification: '需要 ssh 私钥',
    }),
    new AbortController().signal,
  )
  assert.equal(denied.isError, true)
  assert.equal(denied.code, 'permission_denied')
  assert.equal(
    ctx3.events.some((e) => e.type === 'approval.required'),
    false,
    '机密目标不得进入审批（不给予确认扩权的机会）',
  )
})

test('Danger 租约：Shell 免审直跑，grant=danger-lease/danger 且网络自动放行', async () => {
  const ctx = freshContext('workspace-read', true)
  const { input, emitter } = ctx
  const command = 'defaults read com.apple.finder'
  const result = await executeToolCall(
    { ...input, emitter },
    shellRequest('call-d1', command, { requires_network: true }),
    new AbortController().signal,
  )
  assert.equal(result.isError, false)
  assert.equal(
    ctx.events.some((e) => e.type === 'approval.required'),
    false,
    'danger 生效不得再弹普通审批',
  )
  const grant = JSON.parse(ctx.executed[0].grant)
  assert.equal(grant.source, 'danger-lease')
  assert.equal(grant.sandbox, 'danger')
  assert.equal(grant.sandboxNetwork, true, 'danger 自动放行网络但显式记录')
  assert.equal(
    grant.subjectDigest,
    canonicalDigest('shell.execute', [command, '.', 'danger', '1']),
  )
})

test('Danger + require_escalated：提权被 danger 档吸收（roots 不进 grant）', async () => {
  const ctx = freshContext('workspace-read', true)
  const { input, emitter } = ctx
  const command = 'cp x /Users/dev/notes/y'
  const result = await executeToolCall(
    { ...input, emitter },
    shellRequest('call-d2', command, {
      sandbox_permissions: 'require_escalated',
      justification: '导出到笔记目录',
    }),
    new AbortController().signal,
  )
  assert.equal(result.isError, false)
  const grant = JSON.parse(ctx.executed[0].grant)
  assert.equal(grant.sandbox, 'danger')
  assert.equal(grant.escalationRoots, undefined)
})

test('W6 网络收敛：批准 git fetch 联网不放行无关 curl；同前缀复用免双卡', async () => {
  const ctx = freshContext('workspace-write')
  const { approvals, input, emitter } = ctx
  const fetch = executeToolCall(
    { ...input, emitter },
    shellRequest('call-n1', 'git fetch origin', { requires_network: true }),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const cards = ctx.events.filter((e) => e.type === 'approval.required')
  assert.equal(cards.length, 1, '先只弹网络卡')
  assert.equal(cards[0].operation, 'sandbox_network')
  approvals.resolveChoice(cards[0].toolCallId, 'session:network-prefix')
  await fetch
  assert.equal(
    ctx.events.filter((e) => e.type === 'approval.required').length,
    1,
    '网络会话规则同时覆盖命令审批（不再叠主卡）',
  )
  // 同前缀再次执行：双卡都不弹。
  await executeToolCall(
    { ...input, emitter },
    shellRequest('call-n2', 'git fetch upstream', { requires_network: true }),
    new AbortController().signal,
  )
  assert.equal(
    ctx.events.filter((e) => e.type === 'approval.required').length,
    1,
    'git fetch upstream 命中前缀规则',
  )
  // 无关 curl：必须重新询问网络。
  const curl = executeToolCall(
    { ...input, emitter },
    shellRequest('call-n3', 'curl https://example.com', {
      requires_network: true,
    }),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const cards2 = ctx.events.filter((e) => e.type === 'approval.required')
  assert.equal(cards2.length, 2, 'curl 不得复用 git fetch 的网络授权')
  assert.deepEqual(
    cards2[1].choices.map((choice) => choice.id),
    ['allow-once', 'deny'],
    'URL 参数非稳定子命令 → 无会话网络 choice',
  )
  approvals.resolveChoice(cards2[1].toolCallId, 'deny')
  await curl
  // once 网络批准：grant 绑定 sandboxNetwork=true 且不产生任何会话规则。
  const once = executeToolCall(
    { ...input, emitter },
    shellRequest('call-n4', 'git diff HEAD', { requires_network: true }),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  let pending = ctx.events.filter((e) => e.type === 'approval.required')
  approvals.resolveChoice(pending[2].toolCallId, 'allow-once')
  await new Promise((resolve) => setTimeout(resolve, 0))
  pending = ctx.events.filter((e) => e.type === 'approval.required')
  approvals.resolveChoice(pending[3].toolCallId, 'allow-once')
  const onceResult = await once
  assert.equal(onceResult.isError, false)
  const onceGrant = JSON.parse(ctx.executed[ctx.executed.length - 1].grant)
  assert.equal(onceGrant.sandboxNetwork, true)
  // once 网络批准不留会话规则：再次执行同样要问。
  const again = executeToolCall(
    { ...input, emitter },
    shellRequest('call-n5', 'git diff HEAD', { requires_network: true }),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  pending = ctx.events.filter((e) => e.type === 'approval.required')
  assert.equal(pending.length, 5, 'once 批准不产生任何会话网络规则')
  approvals.resolveChoice(pending[4].toolCallId, 'deny')
  await again
})

test('workspace-full：工作区内的复合 Shell 免审批直跑（grant source=preset）', async () => {
  const ctx = freshContext('workspace-full')
  const { input, emitter } = ctx
  const result = await executeToolCall(
    { ...input, emitter },
    shellRequest('call-f1', 'git status && echo done'),
    new AbortController().signal,
  )
  assert.equal(result.isError, false)
  assert.equal(
    ctx.events.some((e) => e.type === 'approval.required'),
    false,
    '完全允许档工作区内命令（含组合形态）不弹卡',
  )
  const grant = JSON.parse(ctx.executed[0].grant)
  assert.equal(grant.source, 'preset')
  assert.equal(grant.sandbox, 'workspace-write')
})

test('workspace-full：require_escalated 仍需提权审批（不因完全允许静默出工作区）', async () => {
  const ctx = freshContext('workspace-full')
  const { approvals, input, emitter } = ctx
  const command = 'cp out.log /Users/dev/notes/archive/run.log'
  const pending = executeToolCall(
    { ...input, emitter },
    shellRequest('call-f2', command, {
      sandbox_permissions: 'require_escalated',
      justification: '归档运行日志到用户笔记目录',
    }),
    new AbortController().signal,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  const required = ctx.events.find((e) => e.type === 'approval.required')
  assert.ok(required, '提权命令在完全允许档也必须弹卡')
  assert.equal(required.risk, 'elevated')
  assert.equal(required.context.escalation, true)
  approvals.resolveChoice(required.toolCallId, 'allow-once')
  const result = await pending
  assert.equal(result.isError, false)
  const grant = JSON.parse(ctx.executed[0].grant)
  assert.equal(grant.sandbox, 'escalated')
  assert.deepEqual(grant.escalationRoots, ['/Users/dev/notes/archive/run.log'])
})
