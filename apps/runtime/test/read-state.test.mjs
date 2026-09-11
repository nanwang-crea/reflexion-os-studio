import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FileReadState,
  extractRevision,
  recordResultRevision,
} from '../dist/agent/tools/read-state.js'

const REVISION = {
  modifiedMs: 1234,
  sizeBytes: 56,
  sha256: 'a'.repeat(64),
}

test('extractRevision accepts well-formed revision fields', () => {
  assert.deepEqual(extractRevision({ revision: REVISION }), REVISION)
})

test('extractRevision rejects malformed or missing fields', () => {
  assert.equal(extractRevision({}), undefined)
  assert.equal(extractRevision({ revision: 'x' }), undefined)
  assert.equal(
    extractRevision({ revision: { ...REVISION, modifiedMs: 'x' } }),
    undefined,
  )
  assert.equal(
    extractRevision({ revision: { ...REVISION, sizeBytes: null } }),
    undefined,
  )
  assert.equal(
    extractRevision({ revision: { ...REVISION, sha256: 'tooshort' } }),
    undefined,
  )
})

test('recordResultRevision stores complete revision credentials', () => {
  const state = new FileReadState()
  recordResultRevision(state, 'a.ts', {
    content: JSON.stringify({ ok: true, revision: REVISION }),
    isError: false,
  })
  const entry = state.entry('a.ts')
  assert.ok(entry, 'entry must be recorded')
  assert.equal(entry.complete, true)
  assert.deepEqual(entry.revision, REVISION)
  // 兼容别名：旧式 mtime 凭据可读。
  assert.equal(state.token('a.ts'), 1234)
})

test('recordResultRevision skips non-JSON or revision-less results', () => {
  const state = new FileReadState()
  recordResultRevision(state, 'a.ts', { content: 'plain text', isError: false })
  recordResultRevision(state, 'b.ts', {
    content: JSON.stringify({ ok: true }),
    isError: false,
  })
  assert.equal(state.entry('a.ts'), undefined)
  assert.equal(state.entry('b.ts'), undefined)
})

test('FileReadState read records keep completeness flag and invalidate clears', () => {
  const state = new FileReadState()
  // 分页窗口凭据：complete=false，只可用于 edit。
  state.record('partial.ts', { revision: REVISION, complete: false })
  state.record('whole.ts', { revision: REVISION, complete: true })
  assert.equal(state.entry('partial.ts').complete, false)
  assert.equal(state.entry('whole.ts').complete, true)
  state.invalidate(['partial.ts', 'missing.ts'])
  assert.equal(state.entry('partial.ts'), undefined)
  assert.equal(state.entry('whole.ts').complete, true)
})
