import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { PluginPackageInstaller } from '../dist/plugins/installer.js'
import { SkillPluginService } from '../dist/skills/service.js'
import { fixture, input } from './fixtures/skill-packages.mjs'

function replacement(f, plugin) {
  const path = join(f.root, 'replacement')
  fs.mkdirSync(path)
  fs.writeFileSync(
    join(path, 'plugin.json'),
    JSON.stringify({ ...plugin.manifest, version: '1.0.1' }),
  )
  fs.writeFileSync(join(path, 'SKILL.md'), 'Replacement instructions')
  return { source: 'local', path }
}

async function withLockedTemporaryFiles(t, execute) {
  const remove = fs.rmSync
  t.mock.method(fs, 'rmSync', (path, ...args) => {
    if (/^\.(author|source|stage)-/.test(basename(String(path)))) {
      throw Object.assign(new Error('temporary file is busy'), {
        code: 'EBUSY',
      })
    }
    return remove(path, ...args)
  })
  syncBuiltinESMExports()
  try {
    return await execute()
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
}

test('a failed database write while repairing a missing directory removes the uncommitted replacement', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input())
  const source = replacement(f, plugin)
  fs.rmSync(plugin.installPath, { recursive: true })
  const installer = new PluginPackageInstaller(
    f.store,
    join(f.data, 'skills'),
    new Set(),
  )
  const upsert = f.store.plugins.upsert
  f.store.plugins.upsert = () => {
    throw new Error('database write failed')
  }
  try {
    await assert.rejects(
      installer.updateFromSource(plugin.id, source, {}),
      /database write failed/,
    )
  } finally {
    f.store.plugins.upsert = upsert
  }
  assert.equal(fs.existsSync(plugin.installPath), false)
  assert.equal(f.store.plugins.get(plugin.id).version, '1.0.0')
})

test('locked temporary files do not turn successful authoring into a failure', async (t) => {
  const f = fixture(t)
  const plugin = await withLockedTemporaryFiles(t, () =>
    f.service.save(input()),
  )
  assert.equal(plugin.sourceRef, plugin.installPath)
  assert.ok(f.service.registry.get(plugin.id))
  assert.ok(fs.existsSync(join(plugin.installPath, 'scripts', 'report.mjs')))
  const restarted = new SkillPluginService(f.store, f.data, () => {})
  t.after(() => restarted.dispose())
  assert.equal(
    fs
      .readdirSync(join(f.data, 'skills'))
      .some((name) => /^\.(author|source|stage)-/.test(name)),
    false,
  )
})

test('temporary cleanup preserves the original installation error', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input())
  const source = replacement(f, plugin)
  const installer = new PluginPackageInstaller(
    f.store,
    join(f.data, 'skills'),
    new Set(),
  )
  await withLockedTemporaryFiles(t, () =>
    assert.rejects(
      installer.updateFromSource(plugin.id, source, {
        onProgress(phase) {
          if (phase === 'committing') throw new Error('original failure')
        },
      }),
      /original failure/,
    ),
  )
  assert.equal(f.store.plugins.get(plugin.id).version, '1.0.0')
  assert.equal(
    JSON.parse(fs.readFileSync(join(plugin.installPath, 'plugin.json'), 'utf8'))
      .version,
    '1.0.0',
  )
})

test('cancellation at the commit boundary does not publish the replacement', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input())
  const source = replacement(f, plugin)
  const installer = new PluginPackageInstaller(
    f.store,
    join(f.data, 'skills'),
    new Set(),
  )
  const controller = new AbortController()
  await assert.rejects(
    installer.updateFromSource(plugin.id, source, {
      signal: controller.signal,
      onProgress(phase) {
        if (phase === 'committing') controller.abort()
      },
    }),
    /cancel|abort/i,
  )
  assert.equal(f.store.plugins.get(plugin.id).version, '1.0.0')
  assert.equal(
    JSON.parse(fs.readFileSync(join(plugin.installPath, 'plugin.json'), 'utf8'))
      .version,
    '1.0.0',
  )
})

test('interrupted legacy copying never publishes a partial package and can retry from its original record', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input())
  const original = join(f.data, 'plugins', plugin.id)
  fs.mkdirSync(join(f.data, 'plugins'))
  fs.cpSync(plugin.installPath, original, { recursive: true })
  fs.rmSync(plugin.installPath, { recursive: true })
  f.store.plugins.upsert({
    ...plugin,
    installPath: original,
    sourceRef: original,
  })
  const copy = fs.copyFileSync
  t.mock.method(fs, 'copyFileSync', (source, target, ...args) => {
    if (basename(String(source)) === 'report.mjs')
      throw new Error('copy interrupted')
    return copy(source, target, ...args)
  })
  syncBuiltinESMExports()
  try {
    const interrupted = new SkillPluginService(f.store, f.data, () => {})
    t.after(() => interrupted.dispose())
    assert.equal(fs.existsSync(plugin.installPath), false)
    assert.equal(f.store.plugins.get(plugin.id).installPath, original)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  const retried = new SkillPluginService(f.store, f.data, () => {})
  t.after(() => retried.dispose())
  assert.ok(fs.existsSync(join(plugin.installPath, 'scripts', 'report.mjs')))
  assert.equal(f.store.plugins.get(plugin.id).installPath, plugin.installPath)
})

test('a package changed during staging cannot redirect an update onto a builtin skill', async (t) => {
  const f = fixture(t)
  const plugin = await f.service.save(input())
  const source = replacement(f, plugin)
  const builtin = join(f.data, 'skills', 'code-review', 'SKILL.md')
  const original = fs.readFileSync(builtin, 'utf8')
  const installer = new PluginPackageInstaller(
    f.store,
    join(f.data, 'skills'),
    new Set(['code-review']),
  )
  await assert.rejects(
    installer.updateFromSource(plugin.id, source, {
      onProgress(phase) {
        if (phase !== 'staging') return
        fs.writeFileSync(
          join(source.path, 'plugin.json'),
          JSON.stringify({
            ...plugin.manifest,
            id: 'code-review',
            version: '1.0.1',
          }),
        )
      },
    }),
    /manifest changed/,
  )
  assert.equal(fs.readFileSync(builtin, 'utf8'), original)
  assert.equal(f.store.plugins.get('code-review'), null)
  assert.equal(f.store.plugins.get(plugin.id).version, '1.0.0')
})
