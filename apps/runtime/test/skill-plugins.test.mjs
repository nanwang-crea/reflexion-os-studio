import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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

async function waitForTask(service, started) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = service.listTasks().find((item) => item.id === started.id)
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`plugin task timed out: ${started.id}`)
}

async function completed(service, task) {
  const result = await waitForTask(service, task)
  assert.equal(result.status, 'completed', result.error ?? undefined)
  return result
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

  const preview = await completed(
    service,
    service.preview({ source: 'local', path: source }),
  )
  assert.equal(preview.manifest.id, 'external-test')
  assert.equal(preview.installed, null)
  const installed = (
    await completed(service, service.install({ source: 'local', path: source }))
  ).plugin
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

test('unsupported root files warn and are not installed', async () => {
  const { root, store, service } = await setup()
  const source = join(root, 'source-package')
  writePackage(source, 'git-metadata-test')
  writeFileSync(join(source, '.gitattributes'), '* text=auto\n')
  writeFileSync(join(source, '.gitignore'), 'dist/\n')
  writeFileSync(join(source, 'LICENSE'), 'Test license\n')

  const preview = await completed(
    service,
    service.preview({ source: 'local', path: source }),
  )
  assert.equal(preview.warnings.length, 3)
  assert.ok(
    preview.warnings.includes('Skipped repository metadata: .gitattributes'),
  )
  assert.ok(
    preview.warnings.includes('Skipped repository metadata: .gitignore'),
  )
  assert.ok(
    preview.warnings.includes('Skipped unsupported plugin root entry: LICENSE'),
  )

  const installed = (
    await completed(service, service.install({ source: 'local', path: source }))
  ).plugin

  assert.equal(existsSync(join(installed.installPath, '.gitattributes')), false)
  assert.equal(existsSync(join(installed.installPath, '.gitignore')), false)
  assert.equal(existsSync(join(installed.installPath, 'LICENSE')), false)
  mkdirSync(join(source, 'assets'))
  writeFileSync(join(source, 'assets', '.gitignore'), 'nested metadata')
  const nestedMetadata = await waitForTask(
    service,
    service.preview({ source: 'local', path: source }),
  )
  assert.match(nestedMetadata.error, /forbidden plugin package entry/)
  store.close()
})

test('local plugin.json file and workspace directory are valid install sources', async () => {
  const { root, store, service } = await setup()
  const local = join(root, 'local-package')
  writePackage(local, 'file-test')
  assert.equal(
    (
      await completed(
        service,
        service.install({ source: 'local', path: join(local, 'plugin.json') }),
      )
    ).plugin.id,
    'file-test',
  )

  const workspace = join(root, 'workspace')
  const workspacePackage = join(workspace, 'skills', 'workspace-test')
  writePackage(workspacePackage, 'workspace-test')
  const project = store.projects.create({ name: 'Test', folderPath: workspace })
  assert.equal(
    (
      await completed(
        service,
        service.install({
          source: 'dir',
          projectId: project.id,
          path: 'skills/workspace-test',
        }),
      )
    ).plugin.source,
    'dir',
  )
  store.close()
})

test('update requires a newer version and keeps disabled state', async () => {
  const { root, store, service } = await setup()
  const source = join(root, 'update-source')
  writePackage(source, 'update-test')
  await completed(service, service.install({ source: 'local', path: source }))
  service.toggle('update-test', false)

  const unchanged = await waitForTask(service, service.update('update-test'))
  assert.equal(unchanged.status, 'failed')
  assert.match(unchanged.error, /must be newer/)
  writePackage(source, 'update-test', {
    version: '1.1.0',
    instructions: '# Updated instructions',
  })
  const updated = (await completed(service, service.update('update-test')))
    .plugin
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
      const installed = (
        await completed(
          service,
          service.install({
            source: 'git',
            url: 'https://example.com/public/skill.git',
          }),
        )
      ).plugin
      assert.equal(installed.source, 'git')
      writePackage(source, 'git-test', { version: '1.1.0' })
      assert.equal(
        (await completed(service, service.update('git-test'))).plugin.version,
        '1.1.0',
      )
    } finally {
      process.env.PATH = previousPath
      delete process.env.REFLEXION_TEST_GIT_SOURCE
      store.close()
    }
  },
)

test(
  'git task reports progress and can be cancelled',
  { skip: process.platform === 'win32' },
  async () => {
    const { root, store, service } = await setup()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const fakeGit = join(bin, 'git')
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env node
process.stderr.write('Receiving objects: 10%\\n')
setInterval(() => {}, 1000)
`,
    )
    chmodSync(fakeGit, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${bin}:${previousPath}`
    try {
      const started = service.install({
        source: 'git',
        url: 'https://example.com/slow/skill.git',
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      service.cancelTask(started.id)
      const cancelled = await waitForTask(service, started)
      assert.equal(cancelled.status, 'cancelled')
      assert.ok(cancelled.progress >= 5)
      assert.equal(existsSync(join(root, 'plugins', 'slow-skill')), false)
    } finally {
      process.env.PATH = previousPath
      store.close()
    }
  },
)

test('startup recovery restores backup and removes abandoned stages', async () => {
  const { root, store, service } = await setup()
  const source = join(root, 'recovery-source')
  writePackage(source, 'recovery-test', { instructions: 'original' })
  const plugin = (
    await completed(service, service.install({ source: 'local', path: source }))
  ).plugin
  const backup = join(root, 'plugins', '.backup-recovery-test-interrupted')
  renameSync(plugin.installPath, backup)
  writePackage(plugin.installPath, 'recovery-test', {
    version: '2.0.0',
    instructions: 'uncommitted replacement',
  })
  writePackage(join(root, 'plugins', '.stage-orphan'), 'orphan-test')
  store.close()

  const restartedStore = new Store(root)
  new SkillPluginService(restartedStore, root, () => {})
  assert.equal(
    readFileSync(join(plugin.installPath, 'SKILL.md'), 'utf8'),
    'original',
  )
  assert.equal(
    readdirSync(join(root, 'plugins')).some((name) => name.startsWith('.')),
    false,
  )
  assert.equal(restartedStore.plugins.get('recovery-test').version, '1.0.0')
  restartedStore.close()
})

test('failed database commit restores the previous package directory', async () => {
  const { root, store, service } = await setup()
  const source = join(root, 'rollback-source')
  writePackage(source, 'rollback-test', { instructions: 'original' })
  const installed = (
    await completed(service, service.install({ source: 'local', path: source }))
  ).plugin
  writePackage(source, 'rollback-test', {
    version: '2.0.0',
    instructions: 'replacement',
  })
  const originalUpsert = store.plugins.upsert.bind(store.plugins)
  store.plugins.upsert = () => {
    throw new Error('simulated database failure')
  }
  const failed = await waitForTask(service, service.update('rollback-test'))
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /simulated database failure/)
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

    const traversal = await waitForTask(
      service,
      service.install({
        source: 'dir',
        projectId: project.id,
        path: '../outside',
      }),
    )
    assert.match(traversal.error, /workspace-relative/)
    const symlink = await waitForTask(
      service,
      service.install({ source: 'local', path: unsafe }),
    )
    assert.match(symlink.error, /symlinks are not allowed/)
    writeFileSync(join(unsafe, '.hidden'), 'forbidden hidden package entry')
    const hidden = await waitForTask(
      service,
      service.preview({ source: 'local', path: unsafe }),
    )
    assert.match(hidden.error, /forbidden plugin package entry/)
    const credentials = await waitForTask(
      service,
      service.preview({
        source: 'git',
        url: 'https://user:token@example.com/plugin.git',
      }),
    )
    assert.match(credentials.error, /credential-free HTTPS/)
    store.close()
  },
)
