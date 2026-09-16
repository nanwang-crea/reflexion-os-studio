import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PermissionGate,
  resolveInputPreset,
  DEFAULT_PRESET,
} from '../dist/agent/permissions/index.js'

function makeGate(preset, opts = {}) {
  let danger = opts.danger === true
  const gate = new PermissionGate({
    preset,
    hasWorkspace: opts.hasWorkspace ?? true,
    approvalOverride: opts.override ?? 'default',
    dangerActive: () => danger,
  })
  return {
    gate,
    setDanger(value) {
      danger = value
    },
  }
}

const pathSubject = (operation, path = 'a/b.ts') => ({
  kind: 'workspace-path',
  operation,
  path,
})
const shellSubject = (extra = {}) => ({
  kind: 'shell-command',
  operation: 'shell.execute',
  commandDigest: 'sha256:x',
  displayCommand: 'git status',
  prefixCandidate: null,
  escalation: false,
  network: false,
  ...extra,
})

test('workspace-read：读取自动、写/删/Shell 询问（不是 denied）', () => {
  const { gate } = makeGate('workspace-read')
  for (const op of ['file.read', 'file.list', 'file.glob', 'file.grep']) {
    assert.equal(
      gate.decisionFor({
        toolName: op,
        subject: pathSubject(op),
        escalation: false,
      }),
      'automatic',
      op,
    )
  }
  for (const op of [
    'file.write',
    'file.edit',
    'file.mkdir',
    'file.move',
    'file.delete',
  ]) {
    assert.equal(
      gate.decisionFor({
        toolName: op,
        subject: pathSubject(op),
        escalation: false,
      }),
      'ask',
      op,
    )
  }
  assert.equal(
    gate.decisionFor({
      toolName: 'shell.execute',
      subject: shellSubject(),
      escalation: false,
    }),
    'ask',
  )
})

test('workspace-write：写/移动自动，删除仍逐次询问', () => {
  const { gate } = makeGate('workspace-write')
  for (const op of ['file.write', 'file.edit', 'file.mkdir', 'file.move']) {
    assert.equal(
      gate.decisionFor({
        toolName: op,
        subject: pathSubject(op),
        escalation: false,
      }),
      'automatic',
      op,
    )
  }
  assert.equal(
    gate.decisionFor({
      toolName: 'file.delete',
      subject: pathSubject('file.delete'),
      escalation: false,
    }),
    'ask',
  )
})

test('workspace-full：全部 automatic（仍受沙箱与 no-read 硬边界）', () => {
  const { gate } = makeGate('workspace-full')
  for (const op of [
    'file.write',
    'file.edit',
    'file.delete',
    'file.move',
    'file.mkdir',
    'shell.execute',
  ]) {
    assert.equal(
      gate.decisionFor({
        toolName: op,
        subject: op === 'shell.execute' ? shellSubject() : pathSubject(op),
        escalation: false,
      }),
      'automatic',
      op,
    )
  }
})

test('ask-everything 覆盖项：automatic 全部升为 ask，denied 不变', () => {
  const { gate } = makeGate('workspace-write', { override: 'ask-everything' })
  assert.equal(
    gate.decisionFor({
      toolName: 'file.read',
      subject: pathSubject('file.read'),
      escalation: false,
    }),
    'ask',
  )
  assert.equal(
    gate.decisionFor({
      toolName: 'file.edit',
      subject: pathSubject('file.edit'),
      escalation: false,
    }),
    'ask',
  )
  // 无工作区硬拒绝不被覆盖项软化。
  const noWs = makeGate('workspace-full', {
    override: 'ask-everything',
    hasWorkspace: false,
  }).gate
  assert.equal(
    noWs.decisionFor({
      toolName: 'file.write',
      subject: pathSubject('file.write'),
      escalation: false,
    }),
    'denied',
  )
})

test('无工作区：file.* 拒绝；Shell 仅显式提权进入审批', () => {
  const { gate } = makeGate('workspace-full', { hasWorkspace: false })
  assert.equal(
    gate.decisionFor({
      toolName: 'file.read',
      subject: pathSubject('file.read'),
      escalation: false,
    }),
    'denied',
  )
  assert.equal(
    gate.decisionFor({
      toolName: 'shell.execute',
      subject: shellSubject(),
      escalation: false,
    }),
    'denied',
  )
  assert.equal(
    gate.decisionFor({
      toolName: 'shell.execute',
      subject: shellSubject({ escalation: true }),
      escalation: true,
    }),
    'ask',
  )
})

test('Danger lease 生效跳过内置审批；撤销立即恢复 preset 决策', () => {
  const { gate, setDanger } = makeGate('workspace-read', {
    override: 'ask-everything',
  })
  assert.equal(
    gate.decisionFor({
      toolName: 'file.delete',
      subject: pathSubject('file.delete'),
      escalation: false,
    }),
    'ask',
  )
  setDanger(true)
  assert.equal(
    gate.decisionFor({
      toolName: 'file.delete',
      subject: pathSubject('file.delete'),
      escalation: false,
    }),
    'automatic',
  )
  // MCP/未知工具不被 Danger 旁路。
  assert.equal(
    gate.decisionFor({
      toolName: 'server/tool-a',
      subject: { kind: 'operation', operation: 'server/tool-a' },
      escalation: false,
    }),
    'ask',
  )
  setDanger(false)
  assert.equal(
    gate.decisionFor({
      toolName: 'file.delete',
      subject: pathSubject('file.delete'),
      escalation: false,
    }),
    'ask',
  )
})

test('MCP 与未知工具默认 ask；纯计算白名单 automatic', () => {
  const { gate } = makeGate('workspace-read')
  const operationSubject = (operation) => ({ kind: 'operation', operation })
  assert.equal(
    gate.decisionFor({
      toolName: 'some-server/some-tool',
      subject: operationSubject('some-server/some-tool'),
      escalation: false,
    }),
    'ask',
  )
  for (const tool of [
    'get_current_time',
    'web.fetch',
    'skill.use',
    'manage_plan',
    'memory.remember',
  ]) {
    assert.equal(
      gate.decisionFor({
        toolName: tool,
        subject: operationSubject(tool),
        escalation: false,
      }),
      'automatic',
      tool,
    )
  }
})

test('legacy 双轨兼容映射：新字段优先、trusted→full、缺省 workspace-read', () => {
  assert.equal(DEFAULT_PRESET, 'workspace-read')
  assert.equal(
    resolveInputPreset({ permissionPreset: 'workspace-write' }),
    'workspace-write',
  )
  // legacy：workspace / read-only 都收敛为最窄日常档。
  assert.equal(
    resolveInputPreset({ permissionMode: 'workspace' }),
    'workspace-read',
  )
  assert.equal(
    resolveInputPreset({ permissionMode: 'read-only' }),
    'workspace-read',
  )
  // legacy：trusted=true 映射 workspace-full。
  assert.equal(
    resolveInputPreset({ permissionMode: 'workspace', trusted: true }),
    'workspace-full',
  )
  // 新旧冲突时新字段优先。
  assert.equal(
    resolveInputPreset({
      permissionPreset: 'workspace-read',
      trusted: true,
    }),
    'workspace-read',
  )
  assert.equal(resolveInputPreset({}), 'workspace-read')
})
