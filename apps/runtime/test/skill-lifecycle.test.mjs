import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fixture, input } from './fixtures/skill-packages.mjs'
import { SkillPluginService } from '../dist/skills/service.js'
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

test('partial uninstall cleanup stays quarantined across rescan and startup recovery', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input())
  f.service.toggle(plugin.id, false)
  const remove = fs.rmSync
  let quarantine
  mockFs(
    t,
    'rmSync',
    (path, ...args) => {
      if (basename(path).startsWith('.remove-')) {
        quarantine = path
        remove(join(path, 'SKILL.md'), { force: true })
        throw new Error('file busy during recursive removal')
      }
      return remove(path, ...args)
    },
    () => assert.equal(f.service.uninstall(plugin.id), true),
  )
  assert.equal(fs.existsSync(plugin.installPath), false)
  assert.equal(fs.existsSync(quarantine), true)
  assert.equal(f.store.plugins.get(plugin.id), null)
  f.service.rescan()
  assert.equal(f.store.plugins.get(plugin.id), null)
  assert.equal(f.service.registry.has(plugin.id), false)
  const restarted = new SkillPluginService(f.store, f.data, () => {})
  t.after(() => restarted.dispose())
  assert.equal(fs.existsSync(quarantine), false)
  assert.equal(f.store.plugins.get(plugin.id), null)
})

test('uninstall database failure restores the existing disabled package', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input())
  f.service.toggle(plugin.id, false)
  t.mock.method(f.store.plugins, 'remove', () => {
    throw new Error('database failed')
  })
  assert.throws(() => f.service.uninstall(plugin.id), /database failed/)
  assert.equal(fs.existsSync(plugin.installPath), true)
  f.service.rescan()
  assert.equal(f.store.plugins.get(plugin.id).enabled, false)
})

test('startup removes incomplete old quarantine after the same skill is reinstalled', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input())
  const remove = fs.rmSync
  let quarantine
  mockFs(
    t,
    'rmSync',
    (path, ...args) => {
      if (basename(path).startsWith('.remove-')) {
        quarantine = path
        remove(join(path, 'SKILL.md'), { force: true })
        throw new Error('file is busy')
      }
      return remove(path, ...args)
    },
    () => f.service.uninstall(plugin.id),
  )
  const replacement = await f.service.save({
    ...input(),
    instructions: 'Replacement instructions',
  })
  const restarted = new SkillPluginService(f.store, f.data, () => {})
  t.after(() => restarted.dispose())
  assert.equal(fs.existsSync(quarantine), false)
  assert.equal(
    fs
      .readFileSync(join(replacement.installPath, 'SKILL.md'), 'utf8')
      .includes('Replacement instructions'),
    true,
  )
  assert.equal(f.store.plugins.get(plugin.id).status, 'enabled')
  assert.ok(restarted.registry.get(plugin.id))
})

test('uninstall preserves both the database and restoration errors', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input())
  const original = new Error('database failed')
  t.mock.method(f.store.plugins, 'remove', () => {
    throw original
  })
  const rename = fs.renameSync
  mockFs(
    t,
    'renameSync',
    (source, ...args) => {
      if (basename(source).startsWith('.remove-'))
        throw new Error('restore failed')
      return rename(source, ...args)
    },
    () =>
      assert.throws(
        () => f.service.uninstall(plugin.id),
        (error) => {
          assert.equal(error.cause, original)
          assert.equal(error.errors[0], original)
          assert.match(error.errors[1].message, /restore failed/)
          return true
        },
      ),
  )
})

test('project removal cascades metadata, preserves disk files and rescan creates no invalid orphan', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input(f.project.id))
  f.store.projects.delete(f.project.id)
  f.service.projectDeleted(f.project.id)
  f.service.rescan()
  assert.equal(f.store.plugins.get(plugin.id), null)
  assert.equal(f.service.registry.has(plugin.id), false)
  assert.equal(fs.existsSync(join(plugin.installPath, 'SKILL.md')), true)
})

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
