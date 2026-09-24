import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PluginRecordSchema } from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'
import { SkillPluginService } from '../dist/skills/service.js'

function writeSkill(root, id, extra = '') {
  const directory = join(root, 'skills', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---
id: ${id}
name: Test Skill
version: 1.0.0
description: Test external skill
tools:
  - file.read
argumentHint: null
${extra}---
# Instructions

Read the requested file.
`,
  )
}

test('skill plugin scan, toggle and restart preserve canonical state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reflexion-skill-plugin-'))
  writeSkill(root, 'external-test')
  const store = new Store(root)
  const service = new SkillPluginService(store, root, () => {})

  assert.equal(service.registry.has('external-test'), true)
  assert.equal(
    service.list().find((item) => item.id === 'external-test').status,
    'enabled',
  )
  for (const plugin of service.list()) {
    assert.equal(PluginRecordSchema.safeParse(plugin).success, true)
  }

  service.toggle('external-test', false)
  assert.equal(service.registry.has('external-test'), false)
  store.close()

  const restartedStore = new Store(root)
  const restarted = new SkillPluginService(restartedStore, root, () => {})
  assert.equal(restarted.registry.has('external-test'), false)
  assert.equal(restartedStore.plugins.get('external-test').status, 'disabled')
  restartedStore.close()
})

test('invalid external skill is isolated without hiding builtins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reflexion-invalid-skill-'))
  writeSkill(root, 'code-review')
  writeSkill(root, 'broken-skill', 'unknownField: nope\n')
  const store = new Store(root)
  const service = new SkillPluginService(store, root, () => {})

  assert.equal(service.registry.has('code-review'), true)
  assert.equal(store.plugins.get('code-review'), null)
  assert.equal(store.plugins.get('broken-skill').status, 'invalid')
  assert.equal(service.registry.has('broken-skill'), false)
  store.close()
})

test('workspace directory install copies and registers a declarative skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reflexion-install-skill-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  writeSkill(workspace, 'install-test')
  const store = new Store(root)
  const project = store.projects.create({ name: 'Test', folderPath: workspace })
  const service = new SkillPluginService(store, root, () => {})

  const installed = service.installFromWorkspace(
    project.id,
    'skills/install-test',
  )

  assert.equal(installed.id, 'install-test')
  assert.equal(installed.source, 'dir')
  assert.equal(service.registry.has('install-test'), true)
  assert.equal(
    service.registry.get('install-test').instructions,
    '# Instructions\n\nRead the requested file.',
  )
  store.close()
})

test(
  'workspace install rejects symlinks and traversal',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'reflexion-install-boundary-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    writeSkill(workspace, 'unsafe-test')
    symlinkSync(
      join(workspace, 'skills', 'unsafe-test', 'SKILL.md'),
      join(workspace, 'skills', 'unsafe-test', 'alias.md'),
    )
    const store = new Store(root)
    const project = store.projects.create({
      name: 'Test',
      folderPath: workspace,
    })
    const service = new SkillPluginService(store, root, () => {})

    assert.throws(
      () => service.installFromWorkspace(project.id, '../outside'),
      /workspace-relative/,
    )
    assert.throws(
      () => service.installFromWorkspace(project.id, 'skills/unsafe-test'),
      /symlinks are not allowed/,
    )
    assert.equal(store.plugins.get('unsafe-test'), null)
    store.close()
  },
)
