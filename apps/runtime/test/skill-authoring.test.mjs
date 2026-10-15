import { inspectPackage } from '../dist/plugins/package.js'
import { fixture, input } from './fixtures/skill-packages.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { SkillPluginService } from '../dist/skills/service.js'
import { createShellExecuteTool } from '../dist/agent/tools/shell.js'
import { ShellOutputStore } from '../dist/agent/tools/shell-output.js'
import {
  SystemRuntimeClient,
  resolveSystemRuntimeBinary,
} from '../dist/system.js'
import {
  canonicalDigest,
  PermissionGate,
} from '../dist/agent/permissions/index.js'

test('creator is builtin; authored packages use scoped directories and preserve resources on update', async (t) => {
  const f = fixture(t)
  assert.ok(f.service.registry.get('skill-creator'))
  const plugin = await f.service.save(input(f.project.id))
  assert.equal(
    plugin.installPath,
    join(f.workspace, '.reflexion-os-studio', 'skills', plugin.id),
  )
  assert.equal(existsSync(join(f.workspace, 'report.txt')), false)
  assert.equal(f.service.registry.get(plugin.id), null)
  assert.throws(() => f.service.prepare(plugin.id, null, 'outside'), /不可用/)
  const snapshot = f.service.prepare(
    plugin.id,
    f.project.id,
    'run',
    'references/input.md',
  )
  assert.equal(snapshot.resource.content, 'Input contract')
  assert.equal(snapshot.nodeExecutable, process.execPath)
  const updated = await f.service.save({
    ...input(f.project.id),
    resources: [],
    mode: 'update',
    expectedVersion: plugin.version,
    instructions: 'Updated instructions',
  })
  assert.equal(updated.version, '1.0.1')
  assert.ok(existsSync(join(updated.installPath, 'scripts', 'report.mjs')))
  await assert.rejects(
    f.service.save({
      ...input(f.project.id),
      mode: 'update',
      expectedVersion: '1.0.0',
    }),
    /版本/,
  )
  writeFileSync(join(snapshot.directory, 'references', 'input.md'), 'tampered')
  assert.equal(
    f.service.prepare(plugin.id, f.project.id, 'run', 'references/input.md')
      .resource.content,
    'Input contract',
  )
  f.service.releaseRun('run')
  assert.equal(existsSync(snapshot.directory), false)
  const global = await f.service.save({ ...input(), id: 'global-helper' })
  assert.equal(global.installPath, join(f.data, 'skills', 'global-helper'))
})

test('scan discovers project packages without a database record; removal keeps other project files', async (t) => {
  const f = fixture(t)
  const packagePath = join(
    f.workspace,
    '.reflexion-os-studio',
    'skills',
    'manual-helper',
  )
  mkdirSync(packagePath, { recursive: true })
  writeFileSync(
    join(packagePath, 'SKILL.md'),
    '---\nname: manual-helper\ndescription: A local project helper.\n---\n\nPerform the requested work.\n',
  )
  f.service.rescan()
  assert.ok(f.service.registry.get('manual-helper', f.project.id))
  assert.equal(f.store.plugins.get('manual-helper').projectId, f.project.id)
  assert.equal(f.service.uninstall('manual-helper'), true)
  assert.equal(existsSync(packagePath), false)
  const saved = await f.service.save(input(f.project.id))
  f.service.projectDeleted(f.project.id)
  assert.ok(existsSync(saved.installPath))
})

test('legacy installs migrate once, remain recoverable and do not resurrect after uninstall', async (t) => {
  const f = fixture(t)
  mkdirSync(join(f.data, 'plugins', 'broken-legacy-helper'), {
    recursive: true,
  })
  const source = join(f.data, 'plugins', 'legacy-helper')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: legacy-helper\ndescription: A legacy helper.\n---\n\nLegacy instructions.\n',
  )
  const migrated = new SkillPluginService(f.store, f.data, () => {})
  t.after(() => migrated.dispose())
  assert.equal(
    f.store.plugins.get('legacy-helper').installPath,
    join(f.data, 'skills', 'legacy-helper'),
  )
  assert.ok(existsSync(source))
  migrated.uninstall('legacy-helper')
  const restarted = new SkillPluginService(f.store, f.data, () => {})
  t.after(() => restarted.dispose())
  assert.equal(restarted.registry.get('legacy-helper'), null)
})

test('unsafe resource and symlink roots are rejected before writing', async (t) => {
  const f = fixture(t)
  await assert.rejects(
    f.service.save({
      ...input(),
      resources: [{ path: 'scripts/../escape.mjs', content: 'invalid' }],
    }),
    /资源/,
  )
  assert.equal(existsSync(join(f.data, 'skills', 'example-helper')), false)
  if (process.platform === 'win32') return
  symlinkSync(f.data, join(f.workspace, '.reflexion-os-studio'))
  await assert.rejects(f.service.save(input(f.project.id)), /符号链接/)
})

test('prepare is automatic but execution retains normal shell permission policy', () => {
  const gate = new PermissionGate({
    preset: 'workspace-read',
    hasWorkspace: true,
    approvalOverride: 'default',
    dangerActive: () => false,
  })
  assert.equal(
    gate.decisionFor({
      toolName: 'skill.prepare',
      subject: { kind: 'other', label: 'skill' },
      escalation: false,
    }),
    'automatic',
  )
  assert.equal(
    gate.decisionFor({
      toolName: 'shell.execute',
      subject: { kind: 'shell-command', command: 'node report.mjs', cwd: '.' },
      escalation: false,
    }),
    'ask',
  )
})

const binary = resolveSystemRuntimeBinary()
test(
  'prepared third-party Node script runs through the actual sandboxed Shell tool',
  { skip: binary === null || process.platform !== 'darwin' },
  async (t) => {
    const f = fixture(t)
    const installed = await f.service.save(input(f.project.id))
    const prepared = f.service.prepare(installed.id, f.project.id, 'native')
    const client = new SystemRuntimeClient(binary, [], () => {})
    client.start()
    t.after(() => client.shutdown())
    const deadline = Date.now() + 10000
    while (!client.available && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25))
    assert.ok(client.available)
    const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'"
    const command = `${quote(prepared.nodeExecutable)} ${quote(join(prepared.directory, 'scripts', 'report.mjs'))} report.txt`
    const grant = JSON.stringify({
      version: 2,
      grantId: 'script',
      requestId: 'native',
      sessionId: 'test',
      workspaceId: f.workspace,
      operation: 'shell.execute',
      source: 'once',
      subjectDigest: canonicalDigest('shell.execute', [
        command,
        '.',
        'workspace-write',
        '0',
      ]),
      sandbox: 'workspace-write',
      sandboxNetwork: false,
      expiresAt: Date.now() + 60000,
    })
    const tool = createShellExecuteTool(
      client,
      f.workspace,
      new ShellOutputStore(),
    )
    const result = await tool.execute({
      args: { command, cwd: '.' },
      grant,
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, false, result.content)
    assert.equal(
      readFileSync(join(f.workspace, 'report.txt'), 'utf8'),
      'actual report\n',
    )
  },
)

test('rescanning leaves active transactions and unrelated hidden files intact; restart cleans only transactions', async (t) => {
  const f = fixture(t)
  const root = join(f.data, 'skills')
  const stage = join(root, '.source-active')
  mkdirSync(stage)
  writeFileSync(join(stage, 'in-progress.txt'), 'cloning')
  writeFileSync(join(root, '.gitignore'), '*.local\n')
  f.service.rescan()
  assert.equal(readFileSync(join(stage, 'in-progress.txt'), 'utf8'), 'cloning')
  const restarted = new SkillPluginService(f.store, f.data, () => {})
  t.after(() => restarted.dispose())
  assert.equal(existsSync(stage), false)
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '*.local\n')
})

test('failed replacement after moving the installed package restores its backup', async (t) => {
  const f = fixture(t)
  const previous = await f.service.save(input())
  const source = join(f.root, 'replacement')
  mkdirSync(source)
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({ ...previous.manifest, version: '1.0.1' }),
  )
  writeFileSync(join(source, 'SKILL.md'), 'Replacement instructions')
  const { PluginPackageInstaller } =
    await import('../dist/plugins/installer.js')
  const { readdirSync } = await import('node:fs')
  const root = join(f.data, 'skills')
  const installer = new PluginPackageInstaller(f.store, root, new Set())
  await assert.rejects(
    installer.updateFromSource(
      previous.id,
      { source: 'local', path: source },
      {
        onProgress(phase) {
          if (phase !== 'committing') return
          for (const name of readdirSync(root)) {
            if (name.startsWith('.stage-'))
              rmSync(join(root, name), { recursive: true, force: true })
          }
        },
      },
    ),
    /ENOENT/,
  )
  assert.ok(existsSync(join(previous.installPath, 'scripts', 'report.mjs')))
  assert.equal(inspectPackage(previous.installPath).version, '1.0.0')
  assert.equal(f.store.plugins.get(previous.id).version, '1.0.0')
})

test('a same-id package in another scope cannot keep a missing installed package enabled', async (t) => {
  const f = fixture(t)
  const installed = await f.service.save(input(f.project.id))
  const globalPath = join(f.data, 'skills', installed.id)
  mkdirSync(globalPath)
  writeFileSync(
    join(globalPath, 'SKILL.md'),
    `---\nname: ${installed.id}\ndescription: A conflicting global package.\n---\n\nOther instructions.\n`,
  )
  rmSync(installed.installPath, { recursive: true })
  f.service.rescan()
  assert.equal(f.store.plugins.get(installed.id).status, 'invalid')
  assert.equal(f.store.plugins.get(installed.id).enabled, false)
})

test(
  'preparing and updating reject a replaced package symlink inside the managed root',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = fixture(t)
    const installed = await f.service.save(input())
    const redirected = join(f.data, 'skills', 'redirected-helper')
    const { renameSync } = await import('node:fs')
    renameSync(installed.installPath, redirected)
    symlinkSync(redirected, installed.installPath)
    assert.throws(
      () => f.service.prepare(installed.id, null, 'linked'),
      /符号链接/,
    )
    await assert.rejects(
      f.service.save({
        ...input(),
        mode: 'update',
        expectedVersion: installed.version,
      }),
      /符号链接/,
    )
    assert.equal(inspectPackage(redirected).version, '1.0.0')
  },
)

test('update preserves a toggle made during installation and does not roll back after backup cleanup fails', async (t) => {
  const f = fixture(t)
  const previous = await f.service.save(input())
  const source = join(f.root, 'replacement')
  mkdirSync(source)
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({ ...previous.manifest, version: '1.0.1' }),
  )
  writeFileSync(join(source, 'SKILL.md'), 'Replacement instructions')
  const { PluginPackageInstaller } =
    await import('../dist/plugins/installer.js')
  const fs = (await import('node:fs')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const originalRemove = fs.rmSync
  t.mock.method(fs, 'rmSync', (path, ...args) => {
    if (String(path).includes('.backup-'))
      throw Object.assign(new Error('backup is busy'), { code: 'EBUSY' })
    return originalRemove(path, ...args)
  })
  syncBuiltinESMExports()
  let updated
  try {
    const installer = new PluginPackageInstaller(
      f.store,
      join(f.data, 'skills'),
      new Set(),
    )
    updated = await installer.updateFromSource(
      previous.id,
      { source: 'local', path: source },
      {
        onProgress(phase) {
          if (phase === 'staging') f.service.toggle(previous.id, false)
        },
      },
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(updated.enabled, false)
  assert.equal(f.store.plugins.get(previous.id).version, '1.0.1')
  assert.equal(inspectPackage(previous.installPath).version, '1.0.1')
  const restarted = new SkillPluginService(f.store, f.data, () => {})
  t.after(() => restarted.dispose())
  assert.equal(f.store.plugins.get(previous.id).version, '1.0.1')
  assert.equal(f.store.plugins.get(previous.id).enabled, false)
})
