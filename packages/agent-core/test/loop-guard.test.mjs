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

test('malformed argument fingerprints hash the entire input with a distinct raw namespace', () => {
  const guard = new LoopGuard()
  const prefix = 'x'.repeat(80)
  const first = { id: 'a', name: 'tool', arguments: prefix + 'a' }
  const second = { ...first, arguments: prefix + 'b' }
  assert.notEqual(guard.fingerprint(first), guard.fingerprint(second))
  assert.notEqual(
    guard.fingerprint(first),
    guard.fingerprint(REQ('tool', { __unparsed: first.arguments })),
  )
  guard.recordExecution(first, OK('applied'), true)
  assert.equal(guard.admit(first).code, 'duplicate_side_effect')
  assert.equal(guard.admit(second).verdict, 'allow')
})

test('obsolete epochs are discarded while the newest mutation remains protected', () => {
  const guard = new LoopGuard()
  let latest
  for (let i = 0; i < 1000; i++) {
    const read = REQ('read', { path: `file-${i}` })
    for (let n = 0; n < 4; n++) guard.recordExecution(read, OK('same'), false)
    guard.recordBlocked(read)
    latest = REQ('write', { path: `file-${i}` })
    guard.recordExecution(latest, OK('written'), true)
    assert.equal(guard.admit(read).verdict, 'allow')
    assert.equal(guard.admit(latest).code, 'duplicate_side_effect')
    guard.recordBlocked(latest)
    assert.equal(guard.admit(latest).terminal, true)
  }
  // Test retained storage, not elapsed time or noisy process memory estimates.
  assert.equal(guard.repetitions.size, 0)
  assert.equal(guard.recoveryWarnings.size, 0)
  assert.equal(guard.protectedMutations.size, 1)
  assert.equal(guard.blockedMutations.size, 1)
  guard.bumpEpoch()
  assert.equal(guard.admit(latest).verdict, 'allow')
  assert.equal(guard.protectedMutations.size, 0)
  assert.equal(guard.blockedMutations.size, 0)
})

test('canonicalJson sorts object keys, keeps array order', () => {
  assert.equal(
    canonicalJson({ b: 1, a: [2, 1], c: { z: 1, y: 2 } }),
    '{"a":[2,1],"b":1,"c":{"y":2,"z":1}}',
  )
})

test('four unchanged reads return a recovery warning before terminal replay', () => {
  const guard = new LoopGuard()
  const request = REQ('file.grep', { path: 'src', q: 'x' })
  assert.equal(guard.admit(request).verdict, 'allow')
  guard.recordExecution(request, OK('hit1'), false)
  assert.equal(guard.admit(request).verdict, 'allow')
  const second = guard.recordExecution(request, OK('hit1'), false)
  assert.equal(second.repeated, true)
  for (let i = 0; i < 2; i++) {
    assert.equal(guard.admit(request).verdict, 'allow')
    guard.recordExecution(request, OK('hit1'), false)
  }
  assert.equal(guard.admit(request).terminal, false)
  guard.recordBlocked(request)
  assert.equal(guard.admit(request).terminal, true)
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
  // 成功调用绑定自身完成后的 epoch，环境尚未发生其它变化时拦截重放。
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
  for (let i = 0; i < 4; i++) guard.recordExecution(request, OK('old'), false)
  guard.recordBlocked(request)
  assert.equal(guard.admit(request).terminal, true)
  guard.bumpEpoch()
  assert.equal(guard.admit(request).verdict, 'allow')
})

test('identical failures allow four executions then one recovery opportunity', () => {
  const guard = new LoopGuard()
  const request = REQ('web.fetch', { url: 'https://down.example' })
  for (let i = 0; i < 4; i++) {
    assert.equal(guard.admit(request).verdict, 'allow')
    guard.recordExecution(request, ERR('timeout'), false)
  }
  const third = guard.admit(request)
  assert.equal(third.verdict, 'block')
  assert.equal(third.code, 'no_progress')
})

test('changed anchors and unchanged reads cannot bypass resource failure limit', () => {
  const guard = new LoopGuard({ stateOnlyTools: new Set(['manage_plan']) })
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

test('blocked mutation becomes eligible again after explicit freshness change', () => {
  const guard = new LoopGuard()
  const edit = REQ('file.edit', { path: 'a.ts', content: 'new' })
  guard.recordExecution(edit, OK('written'), true)
  guard.recordBlocked(edit)
  assert.equal(guard.admit(edit).code, 'no_progress')
  guard.bumpEpoch()
  assert.equal(guard.admit(edit).verdict, 'allow')
})

test('another successful mutation invalidates an earlier replay block', () => {
  const guard = new LoopGuard()
  const edit = REQ('file.edit', { path: 'a.ts', content: 'new' })
  guard.recordExecution(edit, OK('written'), true)
  guard.recordBlocked(edit)
  guard.recordExecution(REQ('file.edit', { path: 'b.ts' }), OK('written'), true)
  assert.equal(guard.admit(edit).verdict, 'allow')
})

test('changing results resets the entire consecutive repetition streak', () => {
  const guard = new LoopGuard()
  const request = REQ('file.read', { path: 'a.ts' })
  for (const content of ['a', 'a', 'a', 'b', 'b', 'b']) {
    assert.equal(guard.admit(request).verdict, 'allow')
    guard.recordExecution(request, OK(content), false)
  }
  assert.equal(guard.admit(request).verdict, 'allow')
  guard.recordExecution(request, OK('b'), false)
  assert.equal(guard.admit(request).terminal, false)
})

test('browser failures remain bounded across changed observation versions', () => {
  const guard = new LoopGuard()
  const request = (version) =>
    REQ('browser.read', {
      tabId: 'owned-tab',
      pageVersion: version,
    })
  for (let i = 0; i < 4; i++)
    guard.recordExecution(
      request(String(i)),
      ERR('loading', 'browser_page_loading'),
      false,
    )
  assert.equal(guard.admit(request('4')).terminal, false)
  guard.recordBlocked(request('4'))
  assert.equal(guard.admit(request('5')).terminal, true)
  guard.bumpEpoch()
  assert.equal(guard.admit(request('6')).verdict, 'allow')
})

test('declared idempotent state changes do not trigger duplicate side effects', () => {
  const guard = new LoopGuard()
  const request = REQ('browser.navigate', { url: 'https://example.com' })
  guard.recordExecution(request, OK('opened'), true, false)
  assert.equal(guard.admit(request).verdict, 'allow')
})

test('successful browser navigation permits recovery from prior tab read failures', () => {
  const guard = new LoopGuard({
    invalidateToolPrefixes: { 'browser.navigate': ['browser.'] },
  })
  const read = REQ('browser.read', { tabId: 'tab', pageVersion: 'old' })
  for (let i = 0; i < 4; i++)
    guard.recordExecution(read, ERR('loading', 'browser_page_loading'), false)
  guard.recordBlocked(read)
  assert.equal(guard.admit(read).terminal, true)
  guard.recordExecution(
    REQ('browser.navigate', { url: 'https://example.com' }),
    OK('opened'),
    true,
    false,
  )
  assert.equal(guard.admit(read).verdict, 'allow')
})

test('failed mutations with uncertain committed effects cannot be replayed', () => {
  const guard = new LoopGuard()
  const request = REQ('browser.execute', { plan: 'submit then read' })
  guard.recordExecution(
    request,
    { ...ERR('read failed'), replayUnsafe: true },
    true,
  )
  assert.equal(guard.admit(request).code, 'duplicate_side_effect')
  guard.recordExecution(
    REQ('browser.read', { tabId: 'tab' }),
    OK('submitted'),
    false,
  )
  assert.equal(guard.admit(request).code, 'duplicate_side_effect')
  guard.recordBlocked(request)
  assert.equal(guard.admit(request).terminal, true)
})

test('resource exhaustion with uncertain mutations still terminates after its warning', () => {
  const guard = new LoopGuard()
  let request
  for (let i = 0; i < 4; i++) {
    request = REQ('browser.execute', {
      page: { tabId: 'tab', pageVersion: String(i) },
    })
    guard.recordExecution(
      request,
      { ...ERR('unknown'), replayUnsafe: true },
      true,
    )
  }
  assert.equal(guard.admit(request).terminal, false)
  guard.recordBlocked(request)
  assert.equal(guard.admit(request).terminal, true)
})
