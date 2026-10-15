import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fixture } from './fixtures/skill-packages.mjs'
import { materializeBuiltinSkills } from '../dist/skills/builtin/packages.js'

function mockFs(t, name, implementation, run) {
  t.mock.method(fs, name, implementation)
  syncBuiltinESMExports()
  try {
    return run()
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
}

test('busy snapshots release active budget and retry cleanup on disposal', (t) => {
  const { service } = fixture(t)
  const original = fs.rmSync
  const retained = new Set()
  mockFs(
    t,
    'rmSync',
    (path, ...args) => {
      if (basename(path).startsWith('reflexion-skill-')) {
        retained.add(path)
        throw new Error('busy snapshot')
      }
      return original(path, ...args)
    },
    () => {
      for (let i = 0; i < 40; i++) {
        service.prepare('code-review', null, `run-${i}`)
        assert.doesNotThrow(() => service.releaseRun(`run-${i}`))
      }
      service.prepare('code-review', null, 'active')
      assert.doesNotThrow(() => service.dispose())
    },
  )
  service.dispose()
  assert.equal(retained.size, 41)
  for (const path of retained) assert.equal(fs.existsSync(path), false)
})

test('damaged builtin entry is restored using its managed manifest', (t) => {
  const { data } = fixture(t)
  const root = join(data, 'skills')
  const entry = join(root, 'code-review', 'SKILL.md')
  const original = fs.readFileSync(entry, 'utf8')
  fs.writeFileSync(entry, '')
  assert.ok(materializeBuiltinSkills(root).has('code-review'))
  assert.equal(fs.readFileSync(entry, 'utf8'), original)
})

test('failed builtin refresh leaves the previous entry intact', (t) => {
  const { data } = fixture(t)
  const root = join(data, 'skills')
  const entry = join(root, 'code-review', 'SKILL.md')
  const before = fs.readFileSync(entry, 'utf8')
  const original = fs.writeFileSync
  mockFs(
    t,
    'writeFileSync',
    (path, ...args) => {
      if (
        String(path).includes('code-review') &&
        (basename(path) === 'SKILL.md' ||
          basename(path).startsWith('.builtin-write-'))
      ) {
        original(path, 'interrupted')
        throw new Error('disk write failed')
      }
      return original(path, ...args)
    },
    () => materializeBuiltinSkills(root),
  )
  assert.equal(fs.readFileSync(entry, 'utf8'), before)
  assert.ok(materializeBuiltinSkills(root).has('code-review'))
})

test('failed initial seed publishes no partial package and can retry', (t) => {
  const { root } = fixture(t)
  const directory = join(root, 'fresh-skills')
  const original = fs.writeFileSync
  mockFs(
    t,
    'writeFileSync',
    (path, ...args) => {
      if (
        basename(path) === 'SKILL.md' ||
        basename(path).startsWith('.builtin-write-')
      ) {
        original(path, 'interrupted')
        throw new Error('disk write failed')
      }
      return original(path, ...args)
    },
    () => materializeBuiltinSkills(directory),
  )
  assert.equal(fs.existsSync(join(directory, 'code-review')), false)
  assert.ok(materializeBuiltinSkills(directory).has('code-review'))
})

test('builtin export preserves user-owned directories', (t) => {
  const { root } = fixture(t)
  const directory = join(root, 'custom-skills')
  const entry = join(directory, 'code-review', 'SKILL.md')
  fs.mkdirSync(join(directory, 'code-review'), { recursive: true })
  fs.writeFileSync(entry, 'user content')
  assert.equal(materializeBuiltinSkills(directory).has('code-review'), false)
  assert.equal(fs.readFileSync(entry, 'utf8'), 'user content')
})

test('snapshot cleanup failure preserves the original preparation error', (t) => {
  const { service } = fixture(t)
  const read = fs.readFileSync
  const remove = fs.rmSync
  const retained = []
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (
      String(path).includes('reflexion-skill-') &&
      !String(path).includes('reflexion-skill-author-') &&
      basename(path) === 'SKILL.md'
    )
      throw new Error('snapshot read failed')
    return read(path, ...args)
  })
  t.mock.method(fs, 'rmSync', (path, ...args) => {
    if (basename(path).startsWith('reflexion-skill-')) {
      retained.push(path)
      throw new Error('cleanup failed')
    }
    return remove(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(
      () => service.prepare('code-review', null, 'broken'),
      /snapshot read failed/,
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  service.dispose()
  assert.ok(retained.length > 0)
  for (const path of retained) assert.equal(fs.existsSync(path), false)
})
