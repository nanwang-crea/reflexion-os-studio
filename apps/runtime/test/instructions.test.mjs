import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import { instructionPath } from '../dist/agent/instructions/paths.js'
import {
  getInstruction,
  remember,
  saveInstruction,
} from '../dist/agent/instructions/service.js'
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
  writeFileSync(join(dataDir, 'AGENTS.md'), '字'.repeat(6000))
  writeFileSync(join(dataDir, 'MEMORY.md'), '记忆短条目')
  const block = await buildInstructionBlock(store, session.id)
  const sections = block.split('\n\n')
  const truncated = sections.find((s) => s.includes('=== 全局指令'))
  const short = sections.find((s) => s.includes('=== 全局记忆'))
  // 超长段：标注截断，且注入正文严格短于 6000 字输入
  assert.ok(truncated.includes('已截断'))
  assert.ok((truncated.match(/字/g) ?? []).length < 6000)
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

test('remember: 全局首建带表头，追加带日期条目', async () => {
  const store = freshStore()
  const outcome = await remember({
    store,
    scope: 'global',
    content: '以后新建项目一律用 pnpm。',
    projectId: null,
  })
  assert.equal(outcome.ok, true)
  const text = await readFile(
    join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md'),
    'utf8',
  )
  assert.ok(text.startsWith('# 记忆'))
  assert.ok(text.includes('## 记忆条目'))
  assert.match(text, /- \d{4}-\d{2}-\d{2} 以后新建项目一律用 pnpm。/)
  await remember({
    store,
    scope: 'global',
    content: '回复保持简短。',
    projectId: null,
  })
  const again = await readFile(
    join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md'),
    'utf8',
  )
  assert.equal(
    again.split('\n').filter((line) => line.startsWith('- ')).length,
    2,
  )
})

test('remember: 项目记忆落在数据目录 memories/<id> 下', async () => {
  const store = freshStore()
  const { project } = sessionInProject(store)
  const outcome = await remember({
    store,
    scope: 'project',
    content: '本项目迁移只增不改。',
    projectId: project.id,
  })
  assert.equal(outcome.ok, true)
  const text = await readFile(
    join(process.env.REFLEXION_DATA_DIR, 'memories', project.id, 'MEMORY.md'),
    'utf8',
  )
  assert.ok(text.includes('本项目迁移只增不改。'))
})

test('remember: 拒绝机密形态/超长/空白，项目 scope 无项目报错', async () => {
  const store = freshStore()
  assert.equal(
    (
      await remember({
        store,
        scope: 'global',
        content: 'token: abcdefghijklmnop1234',
        projectId: null,
      })
    ).code,
    'secret_like',
  )
  assert.equal(
    (
      await remember({
        store,
        scope: 'global',
        content: '字'.repeat(201),
        projectId: null,
      })
    ).code,
    'too_long',
  )
  assert.equal(
    (
      await remember({
        store,
        scope: 'global',
        content: '   ',
        projectId: null,
      })
    ).code,
    'too_long',
  )
  const noProject = await remember({
    store,
    scope: 'project',
    content: '无项目',
    projectId: null,
  })
  assert.equal(noProject.ok, false)
  assert.equal(noProject.code, 'no_project')
})

test('remember: 项目不存在也拒绝（防路径逃逸）', async () => {
  const store = freshStore()
  const outcome = await remember({
    store,
    scope: 'project',
    content: '逃逸尝试',
    projectId: '../../evil',
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'no_project')
})

test('remember: 文件超 64KB 上限时拒绝并提示整理', async () => {
  const store = freshStore()
  await saveInstruction({
    store,
    scope: 'global',
    projectId: null,
    kind: 'memory',
    content: 'x'.repeat(64 * 1024 + 10),
  })
  const outcome = await remember({
    store,
    scope: 'global',
    content: '再记一条',
    projectId: null,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'too_large')
})

test('get/save 指令文件往返', async () => {
  const store = freshStore()
  const { project, projectDir } = sessionInProject(store)
  const missing = await getInstruction({
    store,
    scope: 'global',
    projectId: null,
    kind: 'agents',
  })
  assert.equal(missing.content, '')
  assert.ok(missing.path.endsWith('AGENTS.md'))
  await saveInstruction({
    store,
    scope: 'project',
    projectId: project.id,
    kind: 'agents',
    content: '# 项目指令\n写入用户仓库根。',
  })
  const text = await readFile(join(projectDir, 'AGENTS.md'), 'utf8')
  assert.ok(text.includes('写入用户仓库根。'))
  const saved = await getInstruction({
    store,
    scope: 'project',
    projectId: project.id,
    kind: 'agents',
  })
  assert.equal(saved.content, text)
})
