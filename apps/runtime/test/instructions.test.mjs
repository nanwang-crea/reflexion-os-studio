import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { instructionPath } from '../dist/agent/instructions/paths.js'
import { readOptionalFile } from '../dist/agent/instructions/loader.js'
import { containsSecretLike } from '../dist/agent/instructions/secretGuard.js'
import {
  buildInstructionBlock,
  clipToTokenBudget,
  estimateTextTokens,
} from '../dist/agent/instructions/render.js'

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

test('estimateTextTokens: CJK 按字、拉丁按 4 字符', () => {
  assert.equal(estimateTextTokens('四个汉字'), 4)
  assert.equal(estimateTextTokens('abcdefgh'), 2)
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

test('buildInstructionBlock: 超长文件截断并标注', async () => {
  const store = freshStore()
  const session = store.sessions.create(null)
  writeFileSync(
    join(process.env.REFLEXION_DATA_DIR, 'AGENTS.md'),
    '字'.repeat(6000),
  )
  const block = await buildInstructionBlock(store, session.id)
  assert.ok(block.includes('已截断'))
})

test('buildInstructionBlock: 全部缺失返回空串', async () => {
  const store = freshStore()
  // 真实会话在场，但查询未知 sessionId：不得抛错，全局文件缺失 → 空串。
  store.sessions.create(null)
  assert.equal(await buildInstructionBlock(store, 'no-such-session'), '')
})
