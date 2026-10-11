import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoopGuard, canonicalJson } from '../dist/index.js'

const REQ = (name, args) => ({
  id: `id-${name}`,
  name,
  arguments: JSON.stringify(args),
})
const OK = (content) => ({ content, isError: false, code: undefined })
const ERR = (content, code = 'tool_error') => ({ content, isError: true, code })

test('canonicalJson sorts object keys, keeps array order', () => {
  assert.equal(
    canonicalJson({ b: 1, a: [2, 1], c: { z: 1, y: 2 } }),
    '{"a":[2,1],"b":1,"c":{"y":2,"z":1}}',
  )
})

test('same call admitted twice, third blocked with no_progress', () => {
  const guard = new LoopGuard()
  const request = REQ('file.grep', { path: 'src', q: 'x' })
  assert.equal(guard.admit(request).verdict, 'allow')
  guard.recordExecution(request, OK('hit1'), false)
  assert.equal(guard.admit(request).verdict, 'allow')
  const second = guard.recordExecution(request, OK('hit1'), false)
  assert.equal(second.repeated, true)
  const third = guard.admit(request)
  assert.equal(third.verdict, 'block')
  assert.equal(third.code, 'no_progress')
})

test('different digest resets repetition: changing results keeps admitting', () => {
  const guard = new LoopGuard()
  const request = REQ('file.grep', { path: 'src', q: 'x' })
  guard.recordExecution(request, OK('a'), false)
  guard.recordExecution(request, OK('b'), false)
  // 每次结果都不同 → 不构成无进展重复。
  assert.equal(guard.admit(request).verdict, 'allow')
})

test('mutation success blocks immediate replay but accepts after user turn', () => {
  const guard = new LoopGuard()
  const shell = REQ('shell.execute', { command: 'npm test' })
  guard.recordExecution(shell, OK('pass'), true)
  const epochAfter = guard.currentEpoch()
  assert.equal(epochAfter, 1)
  // 立即重放同一 mutation：环境未变 → duplicate_side_effect 拦截。
  assert.equal(guard.admit(shell).code, 'duplicate_side_effect')
  // 用户发新消息推进 epoch：重跑同一命令视为新鲜（"改代码后重跑测试"）。
  guard.bumpEpoch()
  assert.equal(guard.admit(shell).verdict, 'allow')
})

test('successful mutation replay without freshness change is blocked', () => {
  const guard = new LoopGuard()
  const edit = REQ('file.edit', { path: 'a.ts', content: 'new' })
  guard.recordExecution(edit, OK('written'), true)
  // epoch 已推进；但 successfulMutations 绑定的是执行时的 epoch。
  // 同一 mutation 在任何后续 epoch 都曾成功 → 重放拦截。
  assert.equal(guard.admit(edit).verdict, 'block')
  assert.equal(guard.admit(edit).code, 'duplicate_side_effect')
  // 模型仍重复一次（recordBlocked 累计），第三次按 no_progress 收敛。
  guard.recordBlocked(edit)
  assert.equal(guard.admit(edit).code, 'no_progress')
})

test('mutation failure does not bump epoch nor block replays', () => {
  const guard = new LoopGuard()
  const edit = REQ('file.edit', { path: 'a.ts', content: 'x' })
  guard.recordExecution(edit, ERR('file not found'), true)
  assert.equal(guard.currentEpoch(), 0)
  assert.equal(guard.admit(edit).verdict, 'allow')
})

test('user message bumps epoch: same read after user turn is fresh', () => {
  const guard = new LoopGuard()
  const request = REQ('file.read', { path: 'a.ts' })
  guard.recordExecution(request, OK('old'), false)
  guard.recordExecution(request, OK('old'), false)
  guard.bumpEpoch()
  assert.equal(guard.admit(request).verdict, 'allow')
})

test('no_progress block only after two identical executions, error results count', () => {
  const guard = new LoopGuard()
  const request = REQ('web.fetch', { url: 'https://down.example' })
  guard.recordExecution(request, ERR('timeout'), false)
  guard.recordExecution(request, ERR('timeout'), false)
  const third = guard.admit(request)
  assert.equal(third.verdict, 'block')
  assert.equal(third.code, 'no_progress')
})

test('changed anchors and unchanged reads cannot bypass resource failure limit', () => {
  const guard = new LoopGuard()
  const read = REQ('file.read', { path: './a.ts' })
  const snapshot = OK(JSON.stringify({ revision: { sha256: 'same' } }))
  guard.recordExecution(read, snapshot, false)
  for (let i = 0; i < 4; i++) {
    const edit = REQ('file.edit', { path: 'a.ts', oldText: `guess${i}` })
    assert.equal(guard.admit(edit).verdict, 'allow')
    guard.recordExecution(
      edit,
      ERR('mismatch', 'file_edit_match_conflict'),
      true,
    )
    guard.recordExecution(read, snapshot, false)
    guard.recordExecution(
      REQ('manage_plan', { planId: 'p', action: 'update_step' }),
      OK('updated'),
      true,
    )
  }
  assert.equal(
    guard.admit(REQ('file.edit', { path: './a.ts', oldText: 'new' })).code,
    'no_progress',
  )
  assert.equal(
    guard.admit(REQ('file.edit', { path: 'b.ts', oldText: 'new' })).verdict,
    'allow',
  )
  guard.recordExecution(
    read,
    OK(JSON.stringify({ revision: { sha256: 'changed' } })),
    false,
  )
  assert.equal(
    guard.admit(REQ('file.edit', { path: 'a.ts', oldText: 'new' })).verdict,
    'allow',
  )
})

test('successful write clears failed edits on that resource only', () => {
  const guard = new LoopGuard()
  for (const path of ['a.ts', 'b.ts']) {
    for (let i = 0; i < 4; i++)
      guard.recordExecution(
        REQ('file.edit', { path, oldText: String(i) }),
        ERR('bad'),
        true,
      )
  }
  guard.recordExecution(
    REQ('file.write', { path: 'a.ts', content: 'fixed' }),
    OK('done'),
    true,
  )
  assert.equal(
    guard.admit(REQ('file.edit', { path: 'a.ts', oldText: 'fresh' })).verdict,
    'allow',
  )
  assert.equal(
    guard.admit(REQ('file.edit', { path: 'b.ts', oldText: 'fresh' })).code,
    'no_progress',
  )
})
