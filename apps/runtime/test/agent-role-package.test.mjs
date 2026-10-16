import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { fixture, input } from './fixtures/skill-packages.mjs'
import {
  exportRolePackage,
  previewRolePackage,
  importRolePackage,
} from '../dist/agent/templates/package/service.js'
import {
  decodeArchive,
  encodeArchive,
} from '../dist/agent/templates/package/archive.js'

async function packageFixture(t) {
  const source = fixture(t)
  await source.service.save(input())
  const role = source.store.agents.saveUser({
    name: 'Report role',
    description: 'Reports',
    systemPrompt: 'Write reports.',
    enabled: true,
    allowedTools: ['skill.use', 'file.read'],
    canDelegate: false,
    skills: [{ skillId: 'example-helper', mode: 'startup' }],
  })
  const exported = await exportRolePackage(
    source.store,
    source.service,
    role.id,
    source.root,
  )
  return { source, role, data: readFileSync(exported.path).toString('base64') }
}

test('complete ZIP roundtrips scripts and references, reuses identical content, rejects conflicts', async (t) => {
  const { source, data, role } = await packageFixture(t)
  const files = decodeArchive(data).files
  assert.ok(files['skills/example-helper/scripts/report.mjs'])
  assert.ok(files['skills/example-helper/references/input.md'])
  assert.equal(files['skills/example-helper/plugin.json'], undefined)
  assert.equal(
    JSON.parse(Buffer.from(files['role.json'])).role.skills[0].mode,
    'startup',
  )
  const target = fixture(t)
  const preview = previewRolePackage(
    target.store,
    target.service,
    data,
    target.project.id,
  )
  assert.equal(preview.skills[0].action, 'install')
  assert.equal(target.store.plugins.get('example-helper'), null)
  assert.equal(preview.role.enabled, false)
  const imported = await importRolePackage(
    target.store,
    target.service,
    data,
    target.project.id,
    preview.digest,
  )
  assert.equal(imported.template.enabled, false)
  assert.notEqual(imported.template.id, role.id)
  assert.equal(imported.template.projectId, target.project.id)
  assert.deepEqual(imported.template.modelBinding, { mode: 'inherit' })
  const plugin = target.store.plugins.get('example-helper')
  assert.equal(plugin.projectId, target.project.id)
  assert.equal(plugin.sourceRef, null)
  assert.equal(
    readFileSync(join(plugin.installPath, 'references/input.md'), 'utf8'),
    'Input contract',
  )
  assert.equal(
    previewRolePackage(target.store, target.service, data, target.project.id)
      .skills[0].action,
    'reuse',
  )
  assert.throws(
    () => previewRolePackage(target.store, target.service, data, null),
    /不可用/,
  )
  await source.service.save({
    ...input(),
    mode: 'update',
    expectedVersion: '1.0.0',
  })
  const newer = await exportRolePackage(
    source.store,
    source.service,
    role.id,
    source.root,
  )
  assert.throws(
    () =>
      previewRolePackage(
        target.store,
        target.service,
        readFileSync(newer.path).toString('base64'),
        target.project.id,
      ),
    /冲突/,
  )
})

test('changed preview digest and failed role save never leave newly installed skills', async (t) => {
  const { data } = await packageFixture(t)
  const target = fixture(t)
  const preview = previewRolePackage(target.store, target.service, data, null)
  await assert.rejects(
    importRolePackage(target.store, target.service, data, null, '0'.repeat(64)),
    /重新预览/,
  )
  assert.equal(target.store.plugins.get('example-helper'), null)
  const originalSave = target.store.agents.saveUser
  target.store.agents.saveUser = () => {
    throw new Error('simulated storage failure')
  }
  await assert.rejects(
    importRolePackage(target.store, target.service, data, null, preview.digest),
    /storage failure/,
  )
  target.store.agents.saveUser = originalSave
  assert.equal(target.store.plugins.get('example-helper'), null)
  assert.equal(target.service.registry.get('example-helper'), null)
})

test('ZIP rejects traversal, hidden credentials, symlinks, undeclared files and expansion bombs', async (t) => {
  const { data } = await packageFixture(t)
  const target = fixture(t)
  const files = decodeArchive(data).files
  const encode = (entries) => Buffer.from(zipSync(entries)).toString('base64')
  for (const name of [
    '../escape',
    'skills/example-helper/.env',
    'skills/example-helper/references/private.key',
    'skills/example-helper/references/CON.txt',
    'other.txt',
    'skills/example-helper/extra.txt',
  ]) {
    assert.throws(() =>
      previewRolePackage(
        target.store,
        target.service,
        encode({ ...files, [name]: Buffer.from('bad') }),
        null,
      ),
    )
  }
  const link = zipSync({
    'role.json': [files['role.json'], { os: 3, attrs: 0xa1ff0000 }],
  })
  assert.throws(
    () => decodeArchive(Buffer.from(link).toString('base64')),
    /链接/,
  )
  const bomb = zipSync({ 'role.json': new Uint8Array(33 * 1024 * 1024) })
  assert.throws(
    () => decodeArchive(Buffer.from(bomb).toString('base64')),
    /32MB/,
  )
  assert.throws(
    () => encodeArchive({ 'role.json': new Uint8Array(33 * 1024 * 1024) }),
    /限制/,
  )
})

test('builtin skill full package can be shared and reused', async (t) => {
  const f = fixture(t)
  const role = f.store.agents.saveUser({
    name: 'Review',
    description: 'Review',
    systemPrompt: 'Review.',
    enabled: true,
    allowedTools: ['skill.use'],
    canDelegate: false,
    skills: [{ skillId: 'code-review', mode: 'preferred' }],
  })
  const result = await exportRolePackage(f.store, f.service, role.id, f.root)
  const preview = previewRolePackage(
    f.store,
    f.service,
    readFileSync(result.path).toString('base64'),
    null,
  )
  assert.equal(preview.skills[0].action, 'reuse')
})

test('failed import source finalization removes the installed package', async (t) => {
  const { data } = await packageFixture(t)
  const target = fixture(t)
  const preview = previewRolePackage(target.store, target.service, data, null)
  const original = target.store.plugins.upsert.bind(target.store.plugins)
  target.store.plugins.upsert = (value) => {
    if (value.id === 'example-helper' && value.sourceRef === null)
      throw new Error('finalization failure')
    return original(value)
  }
  await assert.rejects(
    importRolePackage(target.store, target.service, data, null, preview.digest),
    /finalization failure/,
  )
  assert.equal(target.store.plugins.get('example-helper'), null)
  assert.equal(target.service.registry.get('example-helper'), null)
})
