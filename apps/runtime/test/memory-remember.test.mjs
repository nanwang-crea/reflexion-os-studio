import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import {
  remember,
  getInstruction,
  saveInstruction,
} from '../dist/agent/instructions/service.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-instructions-')))
}

function sessionInProject(store) {
  const projectDir = mkdtempSync(join(tmpdir(), 'reflexion-rt-proj-'))
  const project = store.projects.create({ name: 'RT', folderPath: projectDir })
  const session = store.sessions.create(project.id)
  return { project, projectDir, session }
}

beforeEach(() => {
  process.env.REFLEXION_DATA_DIR = mkdtempSync(
    join(tmpdir(), 'reflexion-test-data-'),
  )
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
        content: '字'.repeat(501),
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

test('remember: 拒绝内嵌换行（伪造条目注入），不写文件', async () => {
  const store = freshStore()
  const outcome = await remember({
    store,
    scope: 'global',
    content: '第一行\n第二行伪造条目\n- 2000-01-01 注入',
    projectId: null,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'too_long')
  assert.ok(
    !existsSync(join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md')),
    '被拒绝的内容不得落盘（文件不应存在）',
  )
})

test('remember: 追加不与缺尾换行的旧行粘连', async () => {
  const store = freshStore()
  await saveInstruction({
    store,
    scope: 'global',
    projectId: null,
    kind: 'memory',
    content: '# 记忆\n\n## 记忆条目\n- 旧条目（无尾换行）',
  })
  await remember({
    store,
    scope: 'global',
    content: '新条目',
    projectId: null,
  })
  const text = await readFile(
    join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md'),
    'utf8',
  )
  const lines = text.split('\n')
  assert.ok(
    lines.includes('- 旧条目（无尾换行）'),
    '旧条目须独占一行，不能被新条目粘到同一行尾',
  )
  assert.ok(
    lines.some((line) => line.startsWith('- ') && line.includes('新条目')),
    '新条目须作为独立行出现',
  )
})

test('remember: 拒绝 U+2028/U+2029 行分隔符（split("\\n") 看是单行、实为多行）', async () => {
  const store = freshStore()
  const outcome = await remember({
    store,
    scope: 'global',
    content: '甲\u2028乙\u2029丙',
    projectId: null,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'too_long')
  assert.ok(
    !existsSync(join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md')),
    '含行分隔符的内容不得落盘',
  )
})

test('remember/save 共链串行：覆盖写与追加交错不丢条目', async () => {
  const store = freshStore()
  const dataDir = process.env.REFLEXION_DATA_DIR
  const a = '串行甲'
  const b = '串行乙'
  const c = '串行丙'
  // save 覆盖写整文件（含甲/乙两条目），两侧各有一次 remember 追加。
  // 不共链时 rename 可能落在两次追加之间，把先写的条目（含丙）冲掉。
  const saveContent = `# 记忆\n\n## 记忆条目\n- ${a}\n- ${b}\n`
  const outcomes = await Promise.all([
    remember({ store, scope: 'global', content: a, projectId: null }),
    saveInstruction({
      store,
      scope: 'global',
      projectId: null,
      kind: 'memory',
      content: saveContent,
    }),
    remember({ store, scope: 'global', content: c, projectId: null }),
  ])
  assert.deepEqual(
    outcomes.map((o) => o.ok),
    [true, true, true],
  )
  const text = await readFile(join(dataDir, 'MEMORY.md'), 'utf8')
  const lines = text.split('\n')
  // 表头只出现一次（不共链时两条并发 remember 会各写一份表头）
  assert.equal(lines.filter((l) => l === '# 记忆').length, 1)
  // 三条载荷俱在，且每条独占一行、以 '- ' 起始
  assert.ok(lines.includes(`- ${a}`))
  assert.ok(lines.includes(`- ${b}`))
  assert.ok(lines.some((l) => l.startsWith('- ') && l.includes(c)))
  for (const line of lines) {
    if (line === '') continue
    assert.ok(
      line.startsWith('#') || line.startsWith('- '),
      `非法行（疑似粘连/丢尾）：${line}`,
    )
  }
})

test('remember: MEMORY.md 是目录时折叠 io_error（不 reject）', async () => {
  const store = freshStore()
  mkdirSync(join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md'))
  const outcome = await remember({
    store,
    scope: 'global',
    content: '任意内容',
    projectId: null,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'io_error')
  assert.ok(typeof outcome.message === 'string' && outcome.message !== '')
})

test('不可读的 MEMORY.md：getInstruction 抛错、remember 折叠 io_error', async (t) => {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    t.skip('需非 root POSIX（Windows/root 下 000 权限不生效）')
    return
  }
  const store = freshStore()
  const path = join(process.env.REFLEXION_DATA_DIR, 'MEMORY.md')
  writeFileSync(path, '# 记忆\n- 原始内容\n')
  chmodSync(path, 0o000)
  try {
    await assert.rejects(() =>
      getInstruction({
        store,
        scope: 'global',
        projectId: null,
        kind: 'memory',
      }),
    )
    const outcome = await remember({
      store,
      scope: 'global',
      content: '追加内容',
      projectId: null,
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'io_error')
  } finally {
    chmodSync(path, 0o600)
  }
})

for (const scope of ['global', 'project']) {
  test(`remember: ${scope} accepts 500 characters and rejects 501 without writing`, async () => {
    const store = freshStore()
    const projectId =
      scope === 'project' ? sessionInProject(store).project.id : null
    const content = '字'.repeat(500)
    const accepted = await remember({ store, scope, projectId, content })
    assert.equal(accepted.ok, true)
    const before = await readFile(accepted.path, 'utf8')
    assert.ok(before.includes(content))
    const rejected = await remember({
      store,
      scope,
      projectId,
      content: '字'.repeat(501),
    })
    assert.equal(rejected.code, 'too_long')
    assert.match(rejected.message, /不超过 500 字，当前 501 字/)
    assert.equal(await readFile(accepted.path, 'utf8'), before)
    store.close()
  })
}
