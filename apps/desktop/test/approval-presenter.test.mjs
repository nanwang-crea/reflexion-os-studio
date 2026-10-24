import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const { presentApproval, actionLabelFor } = await import(
  pathToFileURL(outfile).href
)

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
  assert.ok(
    display.details.some(
      (item) => item.label === '沙箱实现' && item.value === 'seatbelt',
    ),
  )
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

test('unsandboxed approval clearly discloses filesystem and network access', () => {
  const display = presentApproval({
    toolCallId: 'unsandboxed',
    runId: 'r1',
    operation: 'shell.execute',
    summary: 'shell.execute: hdiutil create',
    risk: 'elevated',
    subject: {
      ...SHELL_SUBJECT,
      escalation: true,
      prefixCandidate: null,
      network: true,
    },
    context: {
      ...CONTEXT,
      sandbox: 'unsandboxed',
      sandboxProvider: null,
      escalation: true,
      network: true,
      justification: '打包',
    },
    choices: [
      {
        id: 'allow-once',
        decision: 'approved',
        presentation: 'primary',
        label: '解除沙箱并执行一次',
      },
      {
        id: 'deny',
        decision: 'denied',
        presentation: 'secondary',
        label: '拒绝',
      },
    ],
  })
  assert.ok(display.chips.includes('本次解除沙箱（含敏感路径保护）'))
  assert.ok(display.chips.includes('网络不受沙箱限制'))
  assert.equal(display.ruleNote, null)
  assert.equal(display.writeRoots.length, 0)
  assert.match(
    display.details.find((d) => d.label === '解除沙箱').value,
    /敏感路径/,
  )
  assert.equal(
    display.details.some((d) => d.label === '提权'),
    false,
  )
})

test('managed browser approval shows bound source/version without a shell sandbox claim', () => {
  const display = presentApproval({
    toolCallId: 'browser',
    runId: 'run',
    operation: 'browser.read',
    summary: '',
    risk: 'normal',
    context: CONTEXT,
    choices: [],
    subject: {
      kind: 'browser-page',
      operation: 'browser.read',
      origin: 'https://example.com',
      source: {
        origin: 'https://example.com',
        tabId: 'tab',
        pageVersion: 'version',
      },
    },
  })
  assert.equal(display.actionLabel, '读取渲染页面')
  assert.ok(display.subject.value.includes('version'))
  assert.ok(display.chips.includes('隔离 Playwright 浏览器'))
  assert.ok(!display.chips.includes('沙箱 seatbelt'))
})

test('网页交互审批展示精确控件、一次性提示及完整输入供审阅', () => {
  const review = JSON.stringify({
    ref: 'e2',
    element: 'Search',
    text: 'public query',
    submit: true,
  })
  const display = presentApproval({
    toolCallId: 'click-fixture',
    runId: 'run-fixture',
    operation: 'browser.type',
    summary: 'Fill public search',
    risk: 'warning',
    choices: [],
    subject: {
      kind: 'browser-page',
      operation: 'browser.type',
      origin: 'https://example.com',
      target: { ref: 'e2', element: 'Search' },
    },
    context: { ...CONTEXT, network: true, sandboxProvider: null, review },
  })
  assert.equal(display.actionLabel, '填写网页文本')
  assert.match(display.subject.value, /Search（e2）/)
  assert.ok(display.chips.includes('网页交互需单独确认'))
  assert.equal(display.context.review, review)
  assert.equal(actionLabelFor('browser.click'), '点击网页控件')
})

test('网页输入内容默认可见，配置预览仍按需展开', async () => {
  const outfile = join(outDir, 'details.mjs')
  await build({
    absWorkingDir: ROOT,
    stdin: {
      contents: `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { ApprovalDetails } from './frontend/features/chat/approvals/ApprovalDetails'; export const render = display => renderToStaticMarkup(React.createElement(ApprovalDetails, { display, descriptionId: 'fixture' }));`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    jsx: 'automatic',
    outfile,
  })
  const { render } = await import(pathToFileURL(outfile).href)
  const base = {
    toolCallId: 'fixture',
    runId: 'run',
    summary: 'Public input',
    risk: 'warning',
    choices: [],
    context: { ...CONTEXT, review: 'public query to review' },
  }
  const interactive = presentApproval({ ...base, operation: 'browser.type' })
  assert.equal(interactive.reviewAlwaysVisible, true)
  assert.match(render(interactive), /本次网页操作（含输入内容）/)
  assert.match(render(interactive), /public query to review/)
  assert.doesNotMatch(
    render(presentApproval({ ...base, operation: 'skill.save' })),
    /public query to review/,
  )
})
