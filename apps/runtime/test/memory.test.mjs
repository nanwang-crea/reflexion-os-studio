import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
import {
  containsSecretLike,
  parseJsonLoose,
} from '../dist/agent/memory/filter.js'
import { sanitizeCandidates } from '../dist/agent/memory/extractor.js'
import {
  findSimilarExisting,
  sanitizeDecisions,
} from '../dist/agent/memory/merge.js'
import {
  extractQueryTerms,
  ftsScoreFromRank,
  recallMemories,
  renderMemoryBlock,
} from '../dist/agent/memory/recall.js'
import { jaccardSimilarity } from '../dist/agent/memory/similarity.js'

function freshStore() {
  return new Store(mkdtempSync(join(tmpdir(), 'reflexion-memory-')))
}

test('memory CRUD: create, list filters, pin, update, delete', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'P', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)

  const mem = store.memories.create({
    scope: 'project',
    scopeId: project.id,
    kind: 'fact',
    content: '项目使用 pnpm 管理依赖。',
    sourceRunId: null,
  })
  store.memories.create({
    scope: 'session',
    scopeId: session.id,
    kind: 'preference',
    content: '用户偏好中文回复。',
  })

  assert.equal(store.memories.list({}).length, 2)
  assert.equal(store.memories.list({ scope: 'project' }).length, 1)
  assert.equal(
    store.memories.list({ scope: 'session', scopeId: session.id }).length,
    1,
  )

  // pinned 置顶 + 状态流转。
  store.memories.update(mem.id, { status: 'pinned' })
  assert.equal(store.memories.get(mem.id).status, 'pinned')

  // 内容编辑作废向量（此处无向量，只验证内容与 FTS 同步）。
  const updated = store.memories.update(mem.id, {
    content: '项目使用 pnpm workspace。',
  })
  assert.equal(updated.content, '项目使用 pnpm workspace。')

  assert.equal(store.memories.remove(mem.id), true)
  assert.equal(store.memories.get(mem.id), null)
  store.close()
})

test('memory FTS: match and LIKE fallback find candidates', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'P', folderPath: '/tmp/p' })
  store.memories.create({
    scope: 'project',
    scopeId: project.id,
    kind: 'procedure',
    content: '构建命令是 pnpm build:desktop，需要先编译 Rust 宿主。',
  })
  store.memories.create({
    scope: 'project',
    scopeId: project.id,
    kind: 'fact',
    content: '数据库使用 node:sqlite。',
  })

  // ≥3 字符子串走 trigram MATCH。
  const matched = store.memories.searchFts('pnpm build', 10)
  assert.equal(matched.length, 1)
  assert.equal(matched[0].rank !== null, true)

  // 短查询（<3 字符）走 LIKE 扫描，无排名。
  const liked = store.memories.searchFts('构建', 10)
  assert.equal(liked.length, 1)
  assert.equal(liked[0].rank === null, true)

  // 特殊字符不炸。
  assert.deepEqual(store.memories.searchFts('" AND DROP', 10), [])
  assert.deepEqual(store.memories.searchFts('', 10), [])
  store.close()
})

test('memory recall: FTS + recency hybrid without embedding provider', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'P', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  store.memories.create({
    scope: 'project',
    scopeId: project.id,
    kind: 'procedure',
    content: '构建命令是 pnpm build:desktop。',
  })
  // 无关记忆：不应被召回。
  store.memories.create({
    scope: 'project',
    scopeId: project.id,
    kind: 'fact',
    content: '数据库使用 node:sqlite。',
  })
  store.messages.create({
    sessionId: session.id,
    runId: null,
    role: 'user',
    content: '帮我跑一下项目的构建命令',
    status: 'completed',
  })

  const recalled = await recallMemories(store, session.id)
  assert.equal(recalled.length, 1)
  assert.match(recalled[0].content, /build:desktop/)

  const block = renderMemoryBlock(recalled)
  assert.match(block, /^\[相关记忆 · 自动召回\]/)
  assert.match(block, /\[项目\]/)
  store.close()
})

test('memory recall: pinned memory surfaces without query relevance', async () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'P', folderPath: '/tmp/p' })
  const session = store.sessions.create(project.id)
  const pinned = store.memories.create({
    scope: 'project',
    scopeId: project.id,
    kind: 'fact',
    content: '部署目标为 macOS、Windows、Linux 三平台。',
  })
  store.memories.update(pinned.id, { status: 'pinned' })
  store.messages.create({
    sessionId: session.id,
    runId: null,
    role: 'user',
    content: '今天天气怎么样',
    status: 'completed',
  })

  const recalled = await recallMemories(store, session.id)
  assert.equal(recalled.length, 1)
  assert.equal(recalled[0].id, pinned.id)
  store.close()
})

test('embedding roundtrip through Float32 BLOB', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'P', folderPath: '/tmp/p' })
  const mem = store.memories.create({
    scope: 'project',
    scopeId: project.id,
    kind: 'fact',
    content: '向量测试条目。',
  })
  const vector = [0.25, -0.5, 1, 0]
  store.memories.setEmbedding(mem.id, vector, 'mock-embed-model')

  const candidates = store.memories.listRecallCandidates([
    { scope: 'project', scopeId: project.id },
  ])
  assert.equal(candidates.length, 1)
  assert.deepEqual(candidates[0].vector, vector)
  assert.equal(candidates[0].vectorModel, 'mock-embed-model')

  // 模型不一致的向量不出现在其它模型空间（由召回侧判断），这里只验证存取。
  store.close()
})

test('secret filter drops credential-shaped content', () => {
  assert.equal(containsSecretLike('我的 Key 是 sk-abcdefgh12345678'), true)
  assert.equal(containsSecretLike('password: hunter2hunter2'), true)
  assert.equal(
    containsSecretLike('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'),
    true,
  )
  // 正常记忆不误伤。
  assert.equal(containsSecretLike('项目使用 pnpm 管理依赖。'), false)
  assert.equal(
    containsSecretLike('API Key 统一存放在 secrets.json，不进日志。'),
    false,
  )
})

test('loose JSON parsing tolerates fences and prose', () => {
  assert.deepEqual(parseJsonLoose('```json\n[{"a":1}]\n```'), [{ a: 1 }])
  assert.deepEqual(parseJsonLoose('好的，结果如下：[1,2,3]'), [1, 2, 3])
  assert.equal(parseJsonLoose('没有数组'), null)
  assert.equal(parseJsonLoose('['), null)
})

test('candidate sanitizer validates shape and caps size', () => {
  const candidates = sanitizeCandidates([
    {
      kind: 'fact',
      scope: 'project',
      content: '使用 Node 22。',
      confidence: 0.9,
    },
    { kind: 'secret-kind', scope: 'project', content: '无效类型' },
    { kind: 'fact', scope: 'user', content: 'user 级暂不产出' },
    {
      kind: 'fact',
      scope: 'session',
      content: '我的 Key 是 sk-abcdefgh12345678',
    },
    { kind: 'fact', scope: 'session', content: '' },
    'not-an-object',
    {
      kind: 'preference',
      scope: 'session',
      content: '偏好深色主题。',
      confidence: 7,
    },
  ])
  assert.equal(candidates.length, 2)
  assert.equal(candidates[0].content, '使用 Node 22。')
  // confidence 越界被夹到 [0,1]。
  assert.equal(candidates[1].confidence, 1)
})

test('merge decisions: similar lookup scoped per candidate and sanitized', () => {
  const existing = [
    {
      id: 'm1',
      scope: 'project',
      scopeId: 'p1',
      kind: 'fact',
      content: '构建命令是 pnpm build:desktop。',
      sourceRunId: null,
      confidence: 0.8,
      status: 'active',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: null,
    },
  ]
  const candidates = [
    {
      kind: 'fact',
      scope: 'project',
      content: '构建命令是 pnpm build:desktop 需要编译宿主。',
      confidence: 0.9,
    },
    {
      kind: 'fact',
      scope: 'project',
      content: '完全不相关的一条新事实内容。',
      confidence: 0.9,
    },
  ]
  const similarities = findSimilarExisting(
    existing,
    candidates,
    () => () => true,
  )
  assert.equal(similarities[0].similar.length, 1)
  assert.equal(similarities[1].similar.length, 0)

  const decisions = sanitizeDecisions(
    [
      {
        index: 0,
        action: 'UPDATE',
        targetId: 'm1',
        content: '构建命令是 pnpm build:desktop（含宿主编译）。',
      },
      { index: 1, action: 'ADD' },
      { index: 0, action: 'SUPERSEDE', targetId: 'm-unknown', content: 'x' },
      { index: 9, action: 'ADD' },
      { index: 0, action: 'UPDATE', targetId: 'm1' },
    ],
    candidates,
    existing,
  )
  // 合法 UPDATE + ADD 保留；未知 target、越界 index、缺 content 的 UPDATE 被剔除。
  assert.deepEqual(
    decisions.map((d) => [d.index, d.action]),
    [
      [0, 'UPDATE'],
      [1, 'ADD'],
    ],
  )
})

test('jaccard similarity distinguishes related vs unrelated short texts', () => {
  const high = jaccardSimilarity(
    '构建命令是 pnpm build',
    '构建命令是 pnpm build:desktop',
  )
  const low = jaccardSimilarity('构建命令是 pnpm build', '今天天气晴朗适合散步')
  assert.ok(high > 0.35, `expected high similarity, got ${high}`)
  assert.ok(low < 0.35, `expected low similarity, got ${low}`)
})

test('query terms extraction splits punctuation and slides CJK windows', () => {
  // 整句保留在前，CJK 长词追加 4 字滑窗（步长 2），给 trigram 索引可命中的子串。
  assert.deepEqual(extractQueryTerms('帮我跑一下项目的构建命令，谢谢！'), [
    '帮我跑一下项目的构建命令',
    '帮我跑一',
    '跑一下项',
    '下项目的',
    '目的构建',
    '构建命令',
    '谢谢',
  ])
  // 单字符词条对 trigram 无意义，直接过滤。
  assert.deepEqual(extractQueryTerms('a  b   c'), [])
  assert.deepEqual(extractQueryTerms(''), [])
})

test('fts score maps bm25 monotonically: more relevant ranks higher', () => {
  // bm25 越相关数值越小（越负）；分数必须随相关性单调递增而不是反着来。
  assert.equal(ftsScoreFromRank(-5) > ftsScoreFromRank(-1), true)
  assert.equal(ftsScoreFromRank(-1) > ftsScoreFromRank(-0.001), true)
  assert.equal(ftsScoreFromRank(-0.001) > 0, true)
  assert.equal(ftsScoreFromRank(-100) < 1, true)
})

test('removing session/project cleans up memories of that scope', () => {
  const store = freshStore()
  const project = store.projects.create({ name: 'P', folderPath: '/tmp/p' })
  const projectA = store.projects.create({ name: 'Q', folderPath: '/tmp/q' })
  const session = store.sessions.create(project.id)
  const other = store.sessions.create(projectA.id)

  store.memories.create({
    scope: 'session',
    scopeId: session.id,
    kind: 'fact',
    content: '会话 A 的记忆。',
  })
  store.memories.create({
    scope: 'project',
    scopeId: project.id,
    kind: 'fact',
    content: '项目 P 的记忆。',
  })
  store.memories.create({
    scope: 'session',
    scopeId: other.id,
    kind: 'fact',
    content: '其他会话的记忆，不能被误删。',
  })

  // 模拟 session.delete handler 的事务路径。
  store.transaction(() => {
    if (store.sessions.delete(session.id)) {
      store.memories.removeByScope('session', session.id)
    }
  })
  const left = store.memories.list({})
  assert.equal(
    left.some((m) => m.scopeId === session.id),
    false,
  )
  assert.equal(
    left.some((m) => m.scopeId === project.id),
    true,
  )
  assert.equal(
    left.some((m) => m.scopeId === other.id),
    true,
  )

  // 模拟 project.delete：项目与其下会话的记忆一并清理。
  store.transaction(() => {
    if (store.projects.delete(project.id)) {
      store.memories.removeByScope('project', project.id)
    }
  })
  const final = store.memories.list({})
  assert.deepEqual(
    final.map((m) => m.scopeId),
    [other.id],
  )
  store.close()
})
