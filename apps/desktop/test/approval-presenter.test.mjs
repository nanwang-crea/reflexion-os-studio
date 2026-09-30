import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * approval-presenter 纯函数验收：先用 esbuild 把 TS 编成一次性 ESM
 * （前端包无 React 测试基建；presenter 不依赖运行时导入），再断言协议 →
 * 展示模型的映射。覆盖风险文案、chips、规则说明与 choice 兜底。
 */
const outDir = join(tmpdir(), 'reflexion-presenter-test')
mkdirSync(outDir, { recursive: true })
const outfile = join(outDir, 'presenter.mjs')
await build({
  entryPoints: [
    join(ROOT, 'frontend/features/chat/approvals/approval-presenter.ts'),
  ],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile,
})
const { presentApproval, actionLabelFor } = await import(`file://${outfile}`)

const SHELL_SUBJECT = {
  kind: 'shell-command',
  operation: 'shell.execute',
  commandDigest: 'sha256:abc',
  displayCommand: 'pnpm test --filter runtime',
  prefixCandidate: ['pnpm', 'test'],
  escalation: false,
  network: false,
}

const CONTEXT = {
  displayCwd: '…/repo',
  workspaceScope: 'inside',
  permissionPreset: 'workspace-read',
  approvalReason: 'preset-policy',
  sandbox: 'workspace-write',
  sandboxProvider: 'seatbelt',
  network: false,
  escalation: false,
  justification: null,
}

test('文件审批：路径主体 + 工作区内 chip + 会话规则说明', () => {
  const display = presentApproval({
    toolCallId: 't1',
    runId: 'r1',
    operation: 'file.edit',
    summary: 'file.edit: src/a.ts',
    subject: {
      kind: 'workspace-path',
      operation: 'file.edit',
      path: 'src/a.ts',
    },
    risk: 'normal',
    context: CONTEXT,
    choices: [
      {
        id: 'allow-once',
        decision: 'approved',
        presentation: 'primary',
        label: '允许一次',
      },
      {
        id: 'session:file.edit',
        decision: 'approved',
        presentation: 'session-menu',
        label: '本会话允许读取并编辑此文件',
        description: '仅工作区内 src/a.ts',
      },
      {
        id: 'deny',
        decision: 'denied',
        presentation: 'secondary',
        label: '拒绝',
      },
    ],
  })
  assert.equal(display.actionLabel, '编辑文件')
  assert.equal(display.subject.kind, 'path')
  assert.equal(display.subject.value, 'src/a.ts')
  assert.ok(display.chips.some((chip) => chip === '工作区内'))
  assert.ok(display.chips.some((chip) => chip === '当前档位 工作区只读'))
  assert.ok(display.chips.some((chip) => chip === '批准后工作区可写'))
  assert.ok(
    display.details.some(
      (detail) =>
        detail.label === '询问原因' && detail.value.includes('工作区只读'),
    ),
  )
  assert.ok(display.ruleNote.includes('本会话允许读取并编辑此文件'))
  assert.equal(display.choices.length, 3)
})

test('workspace-write + 所有操作均询问：明确显示覆盖项是弹卡原因', () => {
  const display = presentApproval({
    toolCallId: 'override',
    runId: 'r1',
    operation: 'file.edit',
    summary: 'file.edit: src/a.ts',
    subject: {
      kind: 'workspace-path',
      operation: 'file.edit',
      path: 'src/a.ts',
    },
    risk: 'normal',
    context: {
      ...CONTEXT,
      permissionPreset: 'workspace-write',
      approvalReason: 'ask-everything',
    },
  })
  assert.ok(display.chips.includes('当前档位 工作区可写'))
  assert.ok(display.chips.includes('因“所有操作均询问”而确认'))
  assert.ok(
    display.details.some(
      (detail) =>
        detail.label === '询问原因' &&
        detail.value === '本会话已开启“所有操作均询问”',
    ),
  )
})

test('Shell 审批：命令主体 + 档位/网络 chips；无会话 choice 时不显示规则说明', () => {
  const display = presentApproval({
    toolCallId: 't2',
    runId: 'r1',
    operation: 'shell.execute',
    summary: 'shell.execute: pnpm test --filter runtime',
    subject: SHELL_SUBJECT,
    risk: 'warning',
    context: { ...CONTEXT, sandbox: 'read-only' },
    choices: [
      {
        id: 'allow-once',
        decision: 'approved',
        presentation: 'primary',
        label: '允许一次',
      },
      {
        id: 'deny',
        decision: 'denied',
        presentation: 'secondary',
        label: '拒绝',
      },
    ],
  })
  assert.equal(display.risk, 'warning')
  assert.equal(display.subject.kind, 'command')
  assert.equal(display.subject.value, 'pnpm test --filter runtime')
  assert.ok(display.chips.includes('批准后沙箱只读'))
  assert.ok(display.chips.includes('不联网'))
  assert.equal(display.ruleNote, null)
})

test('elevated：提权 chip 文案显式提示工作区外', () => {
  const display = presentApproval({
    toolCallId: 't3',
    runId: 'r1',
    operation: 'shell.execute',
    summary: 'shell.execute: git config',
    subject: { ...SHELL_SUBJECT, escalation: true },
    risk: 'elevated',
    context: {
      ...CONTEXT,
      sandbox: 'escalated',
      escalation: true,
      justification: '导出到全局配置',
    },
    choices: [],
  })
  assert.ok(display.chips.includes('将访问工作区外'))
  assert.ok(display.chips.some((chip) => chip.startsWith('提权')))
  assert.ok(display.details.some((item) => item.value === '导出到全局配置'))
  // choices 为空 → 保守兜底（once + deny），永不渲染空动作区。
  assert.deepEqual(
    display.choices.map((choice) => choice.id),
    ['allow-once', 'deny'],
  )
})

test('降级事件（无 V2 字段）：回退 summary 展示 + normal 风险', () => {
  const display = presentApproval({
    toolCallId: 't4',
    runId: 'r1',
    operation: 'file.write',
    summary: 'file.write: docs/a.md',
  })
  assert.equal(display.risk, 'normal')
  assert.equal(actionLabelFor('file.write'), '写入文件')
  assert.equal(display.subject.value, 'docs/a.md')
  assert.equal(display.chips.length, 0)
})

test('escalation scopes are visible without opening details', () => {
  const roots = ['/private/tmp/export with spaces', '/private/tmp/cache']
  const display = presentApproval({
    operation: 'shell.execute',
    toolCallId: 'esc',
    summary: 'tool --global',
    subject: { ...SHELL_SUBJECT, escalation: true, escalationRoots: roots },
    context: {
      ...CONTEXT,
      escalation: true,
      sandbox: 'escalated',
      justification: 'Write cache',
    },
  })
  assert.deepEqual(display.writeRoots, roots)
  assert.equal(display.context.justification, 'Write cache')
})
