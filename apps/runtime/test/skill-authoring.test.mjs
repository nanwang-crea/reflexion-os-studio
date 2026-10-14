import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../dist/store/index.js'
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

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflexion-skill-author-'))
  const data = join(root, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new Store(data)
  const project = store.projects.create({ name: 'Test', folderPath: workspace })
  const service = new SkillPluginService(store, data, () => {})
  t.after(() => {
    service.dispose()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, data, workspace, store, project, service }
}
const input = (projectId = null) => ({
  requestId: 'save',
  id: 'example-helper',
  description: 'Create a report with a deterministic helper.',
  instructions: 'Use scripts/report.mjs to write report.txt in the workspace.',
  projectId,
  resources: [
    {
      path: 'scripts/report.mjs',
      content:
        "import {writeFileSync} from 'node:fs'; if(process.argv[2] !== 'report.txt') process.exit(2); writeFileSync(process.argv[2], 'actual report\\n'); console.log('done')",
    },
    { path: 'references/input.md', content: 'Input contract' },
  ],
})

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
