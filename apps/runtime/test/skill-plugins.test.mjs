import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PluginPackageManifestSchema,
  PluginRecordSchema,
} from '@reflexion-os-studio/contracts'
import { Store } from '../dist/store/index.js'
import { SkillPluginService } from '../dist/skills/service.js'

function writePackage(directory, id, options = {}) {
  mkdirSync(directory, { recursive: true })
  const manifest = {
    manifestVersion: 1,
    id,
    name: options.name ?? 'Test Skill',
    version: options.version ?? '1.0.0',
    description: 'Test external skill',
    type: 'skill',
    entry: 'SKILL.md',
    compatibility: { protocol: options.protocol ?? '^1.3' },
    capabilities: ['skill.instructions'],
    permissions: {
      filesystem: options.filesystem ?? 'workspace-read',
      network: options.network ?? false,
      shell: false,
    },
    skill: { tools: ['file.read'], argumentHint: null },
  }
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify(manifest))
  writeFileSync(
    join(directory, 'SKILL.md'),
    options.instructions ?? '# Instructions\n\nRead the requested file.\n',
  )
  return manifest
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'reflexion-skill-plugin-'))
  const store = new Store(root)
  const service = new SkillPluginService(store, root, () => {})
  return { root, store, service }
}

test('package manifest and plugin records use the independent contract', () => {
  const manifest = writePackage(
    join(tmpdir(), `reflexion-contract-${Date.now()}`),
    'contract-test',
  )
  assert.equal(PluginPackageManifestSchema.safeParse(manifest).success, true)
})

test('local directory install, toggle and restart preserve canonical state', async () => {
  const { root, store, service } = await setup()
  const source = join(root, 'source-package')
  writePackage(source, 'external-test')

  const preview = service.preview({ source: 'local', path: source })
  assert.equal(preview.manifest.id, 'external-test')
  assert.equal(preview.installed, null)
  const installed = service.install({ source: 'local', path: source })
  assert.equal(installed.manifest.permissions.filesystem, 'workspace-read')
  assert.equal(service.registry.has('external-test'), true)
  assert.equal(PluginRecordSchema.safeParse(installed).success, true)

  service.toggle('external-test', false)
  store.close()
  const restartedStore = new Store(root)
  const restarted = new SkillPluginService(restartedStore, root, () => {})
  assert.equal(restarted.registry.has('external-test'), false)
  assert.equal(restartedStore.plugins.get('external-test').status, 'disabled')
  restartedStore.close()
})

test('local plugin.json file and workspace directory are valid install sources', async () => {
  const { root, store, service } = await setup()
  const local = join(root, 'local-package')
  writePackage(local, 'file-test')
  assert.equal(
    service.install({ source: 'local', path: join(local, 'plugin.json') }).id,
    'file-test',
  )

  const workspace = join(root, 'workspace')
  const workspacePackage = join(workspace, 'skills', 'workspace-test')
  writePackage(workspacePackage, 'workspace-test')
  const project = store.projects.create({ name: 'Test', folderPath: workspace })
  assert.equal(
    service.install({
      source: 'dir',
      projectId: project.id,
      path: 'skills/workspace-test',
    }).source,
    'dir',
  )
  store.close()
})

test('update requires a newer version and keeps disabled state', async () => {
  const { root, store, service } = await setup()
  const source = join(root, 'update-source')
  writePackage(source, 'update-test')
  service.install({ source: 'local', path: source })
  service.toggle('update-test', false)

  assert.throws(() => service.update('update-test'), /must be newer/)
  writePackage(source, 'update-test', {
    version: '1.1.0',
    instructions: '# Updated instructions',
  })
  const updated = service.update('update-test')
  assert.equal(updated.version, '1.1.0')
  assert.equal(updated.enabled, false)
  assert.equal(service.registry.has('update-test'), false)
  store.close()
})

test(
  'HTTPS git source installs and updates through an isolated clone directory',
  { skip: process.platform === 'win32' },
  async () => {
    const { root, store, service } = await setup()
    const source = join(root, 'git-fixture')
    const bin = join(root, 'bin')
    writePackage(source, 'git-test')
    mkdirSync(bin)
    const fakeGit = join(bin, 'git')
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env node
import { cpSync } from 'node:fs'
cpSync(process.env.REFLEXION_TEST_GIT_SOURCE, process.argv.at(-1), { recursive: true })
`,
    )
    chmodSync(fakeGit, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath}`
    process.env.REFLEXION_TEST_GIT_SOURCE = source
    try {
      const installed = service.install({
        source: 'git',
        url: 'https://example.com/public/skill.git',
      })
      assert.equal(installed.source, 'git')
      writePackage(source, 'git-test', { version: '1.1.0' })
      assert.equal(service.update('git-test').version, '1.1.0')
    } finally {
      process.env.PATH = previousPath
      delete process.env.REFLEXION_TEST_GIT_SOURCE
      store.close()
    }
  },
)

test('failed database commit restores the previous package directory', async () => {
  const { root, store, service } = await setup()
  const source = join(root, 'rollback-source')
  writePackage(source, 'rollback-test', { instructions: 'original' })
  const installed = service.install({ source: 'local', path: source })
  writePackage(source, 'rollback-test', {
    version: '2.0.0',
    instructions: 'replacement',
  })
  const originalUpsert = store.plugins.upsert.bind(store.plugins)
  store.plugins.upsert = () => {
    throw new Error('simulated database failure')
  }
  assert.throws(
    () => service.update('rollback-test'),
    /simulated database failure/,
  )
  store.plugins.upsert = originalUpsert
  assert.equal(
    readFileSync(join(installed.installPath, 'SKILL.md'), 'utf8'),
    'original',
  )
  assert.equal(store.plugins.get('rollback-test').version, '1.0.0')
  store.close()
})

test('invalid package is isolated without hiding builtins', async () => {
  const { root, store, service } = await setup()
  const invalid = join(root, 'plugins', 'broken-skill')
  writePackage(invalid, 'broken-skill')
  writeFileSync(join(invalid, 'plugin.json'), '{broken')
  service.rescan()
  assert.equal(service.registry.has('code-review'), true)
  assert.equal(store.plugins.get('broken-skill').status, 'invalid')
  assert.equal(service.registry.has('broken-skill'), false)
  store.close()
})

test(
  'package boundaries reject traversal, symlinks, secrets and credential URLs',
  { skip: process.platform === 'win32' },
  async () => {
    const { root, store, service } = await setup()
    const workspace = join(root, 'workspace')
    const unsafe = join(workspace, 'skills', 'unsafe-test')
    writePackage(unsafe, 'unsafe-test')
    symlinkSync(join(unsafe, 'SKILL.md'), join(unsafe, 'alias.md'))
    const project = store.projects.create({
      name: 'Test',
      folderPath: workspace,
    })

    assert.throws(
      () =>
        service.install({
          source: 'dir',
          projectId: project.id,
          path: '../outside',
        }),
      /workspace-relative/,
    )
    assert.throws(
      () => service.install({ source: 'local', path: unsafe }),
      /symlinks are not allowed/,
    )
    writeFileSync(join(unsafe, '.hidden'), 'forbidden hidden package entry')
    assert.throws(
      () => service.preview({ source: 'local', path: unsafe }),
      /forbidden plugin package entry/,
    )
    assert.throws(
      () =>
        service.preview({
          source: 'git',
          url: 'https://user:token@example.com/plugin.git',
        }),
      /credential-free HTTPS/,
    )
    store.close()
  },
)
