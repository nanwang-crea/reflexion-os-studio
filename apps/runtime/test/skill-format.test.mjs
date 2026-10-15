import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fixture, input } from './fixtures/skill-packages.mjs'
import { inspectPackage } from '../dist/plugins/package.js'
import { PluginPackageInstaller } from '../dist/plugins/installer.js'
import { SkillPluginService } from '../dist/skills/service.js'
import { materializeBuiltinSkills } from '../dist/skills/builtin/packages.js'
import { readSkillFrontmatter } from '../dist/plugins/standard-skill.js'

test('authored skills remain standard packages across updates and restarts', async (t) => {
  const f = fixture(t)
  const first = await f.service.save(input(f.project.id))
  assert.equal(existsSync(join(first.installPath, 'plugin.json')), false)
  const updated = await f.service.save({
    ...input(f.project.id),
    mode: 'update',
    expectedVersion: first.version,
  })
  assert.equal(updated.version, '1.0.1')
  assert.equal(
    readSkillFrontmatter(updated.installPath).metadata.version,
    '1.0.1',
  )
  assert.equal(existsSync(join(updated.installPath, 'plugin.json')), false)
  const restarted = new SkillPluginService(f.store, f.data, () => {})
  t.after(() => restarted.dispose())
  assert.equal(f.store.plugins.get(first.id).version, '1.0.1')
  const prepared = restarted.prepare(
    first.id,
    f.project.id,
    'restarted',
    'references/input.md',
  )
  assert.equal(prepared.resource.content, 'Input contract')
})

test('standard Skill frontmatter remains authoritative and survives authoring', async (t) => {
  const f = fixture(t)
  const path = join(f.data, 'skills', 'example-helper')
  mkdirSync(path)
  writeFileSync(
    join(path, 'SKILL.md'),
    `---
name: example-helper
description: Original description
license: MIT
when_to_use: Report requests
allowed-tools: Read
metadata:
  version: "2.1"
  author: Example
---
Original instructions
`,
  )
  f.service.rescan()
  assert.equal(f.store.plugins.get('example-helper').version, '2.1.0')
  await f.service.save({ ...input(), mode: 'update', expectedVersion: '2.1.0' })
  const metadata = readSkillFrontmatter(path)
  assert.equal(metadata.license, 'MIT')
  assert.equal(metadata.when_to_use, 'Report requests')
  assert.equal(metadata['allowed-tools'], 'Read')
  assert.deepEqual(metadata.metadata, { version: '2.1.1', author: 'Example' })
  writeFileSync(
    join(path, 'SKILL.md'),
    readFileSync(join(path, 'SKILL.md'), 'utf8').replace(
      input().description,
      'Edited description',
    ),
  )
  f.service.rescan()
  assert.equal(
    f.store.plugins.get('example-helper').description,
    'Edited description',
  )
  assert.equal(existsSync(join(path, 'plugin.json')), false)
})

test('builtin exports keep management state outside packages and migrate legacy markers', (t) => {
  const f = fixture(t)
  const path = join(f.data, 'skills', 'code-review')
  const record = join(f.data, 'builtin-skills', 'code-review.json')
  assert.equal(existsSync(join(path, 'plugin.json')), false)
  assert.equal(
    readSkillFrontmatter(path).metadata.reflexionManagedBuiltin,
    undefined,
  )
  const legacy = JSON.parse(readFileSync(record, 'utf8'))
  writeFileSync(join(path, 'plugin.json'), JSON.stringify(legacy))
  rmSync(record)
  writeFileSync(join(path, 'SKILL.md'), '')
  assert.ok(materializeBuiltinSkills(join(f.data, 'skills')).has('code-review'))
  assert.equal(existsSync(join(path, 'plugin.json')), false)
  assert.equal(existsSync(record), true)
  assert.equal(inspectPackage(path).version, legacy.version)
})

test('explicit extension manifests retain their fields and strict version lifecycle', async (t) => {
  const f = fixture(t)
  const first = await f.service.save(input())
  writeFileSync(
    join(first.installPath, 'plugin.json'),
    JSON.stringify({
      ...first.manifest,
      name: 'Extended helper',
      version: '1.1.0',
      skill: { ...first.manifest.skill, tools: ['file.read'] },
    }),
  )
  f.service.rescan()
  const updated = await f.service.save({
    ...input(),
    mode: 'update',
    expectedVersion: '1.1.0',
  })
  assert.equal(updated.version, '1.1.1')
  assert.equal(updated.manifest.name, 'Extended helper')
  assert.deepEqual(updated.manifest.skill.tools, ['file.read'])
  assert.equal(existsSync(join(first.installPath, 'plugin.json')), true)
  const installer = new PluginPackageInstaller(
    f.store,
    join(f.data, 'skills'),
    new Set(),
  )
  await assert.rejects(
    installer.updateFromSource(
      first.id,
      { source: 'local', path: first.installPath },
      {},
    ),
    /must be newer/,
  )
})

test('standard installation preserves source bytes and Python resources without adding a manifest', async (t) => {
  const f = fixture(t)
  const path = join(f.root, 'source')
  mkdirSync(join(path, 'scripts'), { recursive: true })
  const source =
    '---\nname: portable-helper\ndescription: A portable helper\n---\nRun scripts/report.py with Python.\n'
  writeFileSync(join(path, 'SKILL.md'), source)
  writeFileSync(join(path, 'scripts', 'report.py'), 'print("report")\n')
  const installer = new PluginPackageInstaller(
    f.store,
    join(f.data, 'skills'),
    new Set(),
  )
  const installed = await installer.install({ source: 'local', path }, {})
  assert.equal(
    readFileSync(join(installed.installPath, 'SKILL.md'), 'utf8'),
    source,
  )
  assert.equal(
    readFileSync(join(installed.installPath, 'scripts', 'report.py'), 'utf8'),
    'print("report")\n',
  )
  assert.equal(existsSync(join(path, 'plugin.json')), false)
  assert.equal(existsSync(join(installed.installPath, 'plugin.json')), false)
})
