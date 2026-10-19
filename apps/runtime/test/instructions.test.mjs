import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { instructionPath } from '../dist/agent/instructions/paths.js'
import {
  remember,
  deleteProjectMemoryDir,
  sweepOrphanMemoryDirs,
} from '../dist/agent/instructions/service.js'
import { readOptionalFile } from '../dist/agent/instructions/loader.js'
import { containsSecretLike } from '../dist/agent/instructions/secretGuard.js'
import {
  buildInstructionBlock,
  clipToTokenBudget,
  estimateTextTokens,
} from '../dist/agent/instructions/render.js'
import { commandHandlers } from '../dist/handlers.js'
import { PermissionGate } from '../dist/agent/permissions/index.js'
import { PRIMARY_AGENT_SYSTEM_PROMPT } from '../dist/agent/prompts/index.js'
import { createMemoryRememberTool } from '../dist/agent/tools/instructions.js'
import { createToolRegistry } from '../dist/agent/tools/index.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-instructions-')))
}

// 全局 AGENTS/MEMORY 文件按 resolveDataDir()（即 REFLEXION_DATA_DIR）落地，
// 而 bootstrap 只给整个进程设一个共享目录：不清理会在用例间互相污染（上一条
// 写的文件被下一条读到）。每个用例前换到全新数据目录，保证「缺失」用例可读。
beforeEach(() => {
  process.env.REFLEXION_DATA_DIR = mkdtempSync(
    join(tmpdir(), 'reflexion-test-data-'),
  )
})

test('instructionPath: 全局两类文件在数据目录下', () => {
  const store = freshStore()
  const dataDir = process.env.REFLEXION_DATA_DIR
  assert.ok(dataDir, 'set-test-data-dir 应已注入 REFLEXION_DATA_DIR')
  assert.equal(
    instructionPath(store, 'global', 'agents', null),
    join(dataDir, 'AGENTS.md'),
  )
  assert.equal(
    instructionPath(store, 'global', 'memory', null),
    join(dataDir, 'MEMORY.md'),
  )
})

test('instructionPath: 项目 AGENTS.md 在项目 folderPath，项目 MEMORY.md 在数据目录', () => {
  const store = freshStore()
  const projectDir = mkdtempSync(join(tmpdir(), 'reflexion-proj-'))
  const project = store.projects.create({ name: 'P', folderPath: projectDir })
  assert.equal(
    instructionPath(store, 'project', 'agents', project.id),
    join(projectDir, 'AGENTS.md'),
  )
  assert.equal(
    instructionPath(store, 'project', 'memory', project.id),
    join(process.env.REFLEXION_DATA_DIR, 'memories', project.id, 'MEMORY.md'),
  )
})

test('instructionPath: 无项目/空 folderPath 返回 null', () => {
  const store = freshStore()
  assert.equal(instructionPath(store, 'project', 'agents', null), null)
  assert.equal(instructionPath(store, 'project', 'memory', null), null)
  const bare = store.projects.create({ name: 'B', folderPath: '' })
  assert.equal(instructionPath(store, 'project', 'agents', bare.id), null)
})

test('instructionPath: 不存在的 projectId 不得拼出数据目录内路径', () => {
  const store = freshStore()
  assert.equal(
    instructionPath(store, 'project', 'memory', 'no-such-project'),
    null,
  )
})

test('readOptionalFile: 缺失返回空串，存在返回内容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reflexion-read-'))
  assert.equal(await readOptionalFile(join(dir, 'nope.md')), '')
  writeFileSync(join(dir, 'ok.md'), '你好\n')
  assert.equal(await readOptionalFile(join(dir, 'ok.md')), '你好\n')
  assert.equal(await readOptionalFile(null), '')
  assert.equal(await readOptionalFile(dir), '')
})

test('containsSecretLike: 拒绝凭据形态、放行普通句子', () => {
  assert.equal(containsSecretLike('我的 api_key: sk-abcdef0123456789'), true)
  assert.equal(containsSecretLike('密码：hunter2secret'), true)
  assert.equal(
    containsSecretLike(
      'Authorization: Bearer eyJhbGciOiJIUzI1Ni5zdWJzdWJzdWJzdWJzdWJzdWI',
    ),
    true,
  )
  assert.equal(containsSecretLike('项目统一使用 pnpm 管理依赖。'), false)
  assert.equal(
    containsSecretLike('API Key 统一存放在 secrets.json，不进日志。'),
    false,
  )
})

function sessionInProject(store) {
  const projectDir = mkdtempSync(join(tmpdir(), 'reflexion-rt-proj-'))
  const project = store.projects.create({ name: 'RT', folderPath: projectDir })
  const session = store.sessions.create(project.id)
  return { project, projectDir, session }
}

test('estimateTextTokens: 复用 agent-core 口径（假名按字、其余按码点向上取整）', () => {
  assert.equal(estimateTextTokens('四个汉字'), 4)
  assert.equal(estimateTextTokens('abcdefgh'), 2)
  // 假名落在 \u3000-\u9fff 区间按字计（旧本地正则从 \u4e00 起，会把它误判成 1）
  assert.equal(estimateTextTokens('ひらがな'), 4)
  // emoji 按码点而非 UTF-16 单元计：与 abc 共 4 码点 → ceil(4/4)=1（旧口径按长度 5 得 2）
  assert.equal(estimateTextTokens('🙂abc'), 1)
})

test('clipToTokenBudget: 预算内原样、超预算保头截断并标记', () => {
  const kept = clipToTokenBudget('短内容', 4000)
  assert.equal(kept.truncated, false)
  const clipped = clipToTokenBudget('记'.repeat(5000), 100)
  assert.equal(clipped.truncated, true)
  assert.ok(estimateTextTokens(clipped.text) <= 100)
})

test('buildInstructionBlock: 四层顺序 + 缺失跳过 + 截断标记', async () => {
  const store = freshStore()
  const { project, projectDir, session } = sessionInProject(store)
  const dataDir = process.env.REFLEXION_DATA_DIR
  writeFileSync(join(dataDir, 'AGENTS.md'), '全局纪律：回复用中文。')
  writeFileSync(join(dataDir, 'MEMORY.md'), '- 全局记忆条目')
  mkdirSync(join(dataDir, 'memories', project.id), { recursive: true })
  writeFileSync(join(dataDir, 'memories', project.id, 'MEMORY.md'), '- 条目A')
  writeFileSync(join(projectDir, 'AGENTS.md'), '项目纪律：用 pnpm。')
  const block = await buildInstructionBlock(store, session.id)
  assert.ok(block.includes('全局指令'))
  assert.ok(block.includes('全局纪律：回复用中文。'))
  assert.ok(block.indexOf('全局指令') < block.indexOf('项目指令'))
  assert.ok(block.indexOf('项目指令') < block.indexOf('全局记忆'))
  assert.ok(block.indexOf('全局记忆') < block.indexOf('项目记忆'))
  assert.ok(block.includes('- 条目A'))
  // 空文件/缺失文件不产生段：用段标题（=== 全局指令）判定，避免项目段标签里
  // 的「与全局指令冲突时…」字样造成误判。
  writeFileSync(join(dataDir, 'AGENTS.md'), '')
  const block2 = await buildInstructionBlock(store, session.id)
  assert.ok(!block2.includes('=== 全局指令'))
  assert.ok(block2.includes('=== 项目指令'))
})

test('buildInstructionBlock: 独立会话只有全局两层', async () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  writeFileSync(join(process.env.REFLEXION_DATA_DIR, 'AGENTS.md'), 'G')
  const block = await buildInstructionBlock(store, session.id)
  assert.ok(block.includes('全局指令'))
  assert.ok(!block.includes('项目指令'))
})

test('buildInstructionBlock: 超长文件截断并标注、同块短文件段不误标', async () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const dataDir = process.env.REFLEXION_DATA_DIR
  writeFileSync(join(dataDir, 'AGENTS.md'), '字'.repeat(25000))
  writeFileSync(join(dataDir, 'MEMORY.md'), '记忆短条目')
  const block = await buildInstructionBlock(store, session.id)
  const sections = block.split('\n\n')
  const truncated = sections.find((s) => s.includes('=== 全局指令'))
  const short = sections.find((s) => s.includes('=== 全局记忆'))
  // 超长段：标注截断，且注入正文严格短于 25000 字输入
  assert.ok(truncated.includes('已截断'))
  assert.ok((truncated.match(/字/g) ?? []).length < 25000)
  // 同块短文件段：内容原样注入，不得被误标为截断
  assert.ok(short.includes('记忆短条目'))
  assert.ok(!short.includes('已截断'))
})

test('buildInstructionBlock: 全部缺失返回空串', async () => {
  const store = freshStore()
  // 真实会话在场，但查询未知 sessionId：不得抛错，全局文件缺失 → 空串。
  store.sessions.create(null)
  assert.equal(await buildInstructionBlock(store, 'no-such-session'), '')
})

test('接线：instructions 命令有 handler、remember 工具免审批、prompt 有约定', () => {
  assert.ok(commandHandlers['instructions.get'])
  assert.ok(commandHandlers['instructions.save'])
  const gate = new PermissionGate({
    preset: 'workspace-read',
    hasWorkspace: false,
    approvalOverride: 'default',
    dangerActive: () => false,
  })
  assert.equal(
    gate.decisionFor({
      toolName: 'memory.remember',
      subject: { kind: 'operation', operation: 'memory.remember' },
      escalation: false,
    }),
    'automatic',
  )
  assert.ok(PRIMARY_AGENT_SYSTEM_PROMPT.includes('memory.remember'))
})

test('instructions.get/save 经 handler 往返', async () => {
  const store = freshStore()
  const ctx = { store }
  const saved = await commandHandlers['instructions.save'](
    {
      scope: 'global',
      kind: 'memory',
      content: '# 记忆\n\n## 记忆条目\n- 2026-09-12 手写条目',
    },
    ctx,
  )
  assert.equal(saved.ok, true)
  const got = await commandHandlers['instructions.get'](
    { scope: 'global', kind: 'memory' },
    ctx,
  )
  assert.ok(got.content.includes('手写条目'))
})

test('注入与命令面读同一真相源：同一 AGENTS.md 两处内容一致', async () => {
  const store = freshStore()
  const { session } = sessionInProject(store)
  const text = '全局纪律：注入与指令页必须看到同一份文件。'
  writeFileSync(join(process.env.REFLEXION_DATA_DIR, 'AGENTS.md'), text)
  const block = await buildInstructionBlock(store, session.id)
  const got = await commandHandlers['instructions.get'](
    { scope: 'global', kind: 'agents' },
    { store },
  )
  assert.equal(got.content, text)
  assert.ok(block.includes(text))
})

// memory.remember execute 层测试：最小 ToolContext（对齐 plans.test.mjs 的
// baseCtx 模式；本工具只用 store + sessionId，其余字段为 createToolRegistry 装配兜底）。
function rememberCtx(store, sessionId) {
  return {
    store,
    sessionId,
    messageId: 'message-1',
    runId: 'run-1',
    emitter: { next: () => {} },
    system: null,
    workspaceRoot: null,
    skills: { get: () => null, list: () => [] },
    mcp: null,
  }
}

function callScope(tool, scope, content) {
  return tool.execute({
    args: { scope, content },
    signal: new AbortController().signal,
  })
}

test('memory.remember execute: 合法 global → 写入数据目录、消息含路径', async () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const tool = createMemoryRememberTool(rememberCtx(store, session.id))
  const result = await callScope(tool, 'global', '回复统一用中文。')
  assert.equal(result.isError, false)
  const text = await readFile(
    join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md'),
    'utf8',
  )
  assert.ok(text.startsWith('# 记忆'))
  assert.match(text, /- \d{4}-\d{2}-\d{2} 回复统一用中文。/)
  assert.ok(result.content.includes(process.env.REFLEXION_DATA_DIR))
})

test('memory.remember execute: 无项目会话 scope=project → no_project', async () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const tool = createMemoryRememberTool(rememberCtx(store, session.id))
  const result = await callScope(tool, 'project', '项目纪律')
  assert.equal(result.isError, true)
  assert.equal(result.code, 'no_project')
})

test('memory.remember execute: 非法 scope 显式拒绝、不回落 global 写盘', async () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  const tool = createMemoryRememberTool(rememberCtx(store, session.id))
  const result = await callScope(tool, 'Project', '大小写笔误')
  assert.equal(result.isError, true)
  assert.equal(result.code, 'invalid_request')
  assert.equal(
    existsSync(join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md')),
    false,
  )
})

test('memory.remember execute: 项目会话 scope=project → memories/<id>/MEMORY.md', async () => {
  const store = freshStore()
  const { project, session } = sessionInProject(store)
  const tool = createMemoryRememberTool(rememberCtx(store, session.id))
  const result = await callScope(tool, 'project', '本项目依赖统一 pnpm。')
  assert.equal(result.isError, false)
  const text = await readFile(
    join(process.env.REFLEXION_DATA_DIR, 'memories', project.id, 'MEMORY.md'),
    'utf8',
  )
  assert.ok(text.includes('本项目依赖统一 pnpm。'))
})

test('工具装配：createToolRegistry 始终注册 memory.remember', () => {
  const registry = createToolRegistry(rememberCtx(freshStore(), 'session-1'))
  assert.ok(registry.list().some((tool) => tool.name === 'memory.remember'))
})

test('deleteProjectMemoryDir: 项目记忆目录整体删除、重复调用无害', async () => {
  const store = freshStore()
  const { project } = sessionInProject(store)
  const outcome = await remember({
    store,
    scope: 'project',
    content: '项目纪律A。',
    projectId: project.id,
  })
  assert.equal(outcome.ok, true)
  const dir = join(process.env.REFLEXION_DATA_DIR, 'memories', project.id)
  assert.ok(existsSync(dir))
  await deleteProjectMemoryDir(project.id)
  assert.equal(existsSync(dir), false)
  // 目录已不存在：force 语义，不抛错。
  await deleteProjectMemoryDir(project.id)
})

test('project.delete handler: 行删除成功后项目记忆目录随清', async () => {
  const store = freshStore()
  const { project } = sessionInProject(store)
  await remember({
    store,
    scope: 'project',
    content: '随项目删除。',
    projectId: project.id,
  })
  const dir = join(process.env.REFLEXION_DATA_DIR, 'memories', project.id)
  assert.ok(existsSync(dir))
  const ctx = {
    store,
    agent: { clearQueue: () => {}, clearSessionResources: () => {} },
    approvals: { clearSession: () => {} },
    danger: { revoke: () => false },
    assets: {
      deleteProjectDir: async () => {},
      deleteSessionDir: async () => {},
    },
    terminal: { closeProject: async () => {} },
  }
  const result = await commandHandlers['project.delete'](
    { projectId: project.id },
    ctx,
  )
  assert.equal(result.removed, true)
  assert.equal(existsSync(dir), false)
})

test('sweepOrphanMemoryDirs: 无项目行的孤儿目录删除、在者保留', async () => {
  const store = freshStore()
  const { project: live } = sessionInProject(store)
  const { project: dead } = sessionInProject(store)
  const dirOf = (id) => join(process.env.REFLEXION_DATA_DIR, 'memories', id)
  await remember({
    store,
    scope: 'project',
    content: '活项目。',
    projectId: live.id,
  })
  await remember({
    store,
    scope: 'project',
    content: '死项目。',
    projectId: dead.id,
  })
  // 模拟行删除成功但目录清理失败/进程中断后的残留。
  store.projects.delete(dead.id)
  await sweepOrphanMemoryDirs(store)
  assert.equal(existsSync(dirOf(dead.id)), false)
  assert.ok(existsSync(dirOf(live.id)))
})
