import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveMcpLaunch, mcpEnvironment } from '../dist/mcp/launch.js'
import { npmInstallation } from './fixtures/npm-installation.mjs'

function installation(t, name = 'npx.cmd') {
  const directory = mkdtempSync(join(tmpdir(), 'mcp npm layout '))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const fixture = npmInstallation(directory, name)
  return {
    ...fixture,
    env: { Path: dirname(fixture.launcher), PATHEXT: '.CMD;.EXE' },
  }
}

for (const name of [
  'npm.cmd',
  'global npm/npx.cmd',
  'node_modules/.bin/npx.cmd',
]) {
  test(`validated Windows npm launcher becomes Node plus CLI: ${name}`, async (t) => {
    const { launcher, cli, env } = installation(t, name)
    const args = ['a^b', 'quote"value', '%PATH%', '!bang!', '', 'trailing\\']
    assert.deepEqual(await resolveMcpLaunch(launcher, args, env, 'win32'), {
      command: process.execPath,
      args: [cli, ...args],
    })
    const command = name.endsWith('npm.cmd') ? 'npm' : 'npx'
    assert.deepEqual(await resolveMcpLaunch(command, args, env, 'win32'), {
      command: process.execPath,
      args: [cli, ...args],
    })
  })
}

test('Windows environment override removes differently cased PATH keys', () => {
  const env = mcpEnvironment(
    { PATH: 'new', other: 'override' },
    { Path: 'old', OTHER: 'base', KEEP: 'yes' },
    'win32',
  )
  assert.deepEqual(env, { KEEP: 'yes', PATH: 'new', other: 'override' })
  assert.deepEqual(mcpEnvironment({ PATH: 'new' }, { Path: 'old' }, 'linux'), {
    Path: 'old',
    PATH: 'new',
  })
})

test('unverified npm layout and custom npm wrapper are left untouched', async (t) => {
  const { launcher, cli, packageDirectory, env } = installation(t)
  const original = { command: launcher, args: ['a^b'] }
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: 'other', bin: { npx: 'bin/npx-cli.js' } }),
  )
  assert.deepEqual(
    await resolveMcpLaunch(launcher, original.args, env, 'win32'),
    original,
  )
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: 'npm', bin: { npx: 'bin/npx-cli.js' } }),
  )
  writeFileSync(launcher, '@echo off\r\necho custom behavior\r\n')
  assert.deepEqual(
    await resolveMcpLaunch(launcher, original.args, env, 'win32'),
    original,
  )
  rmSync(cli)
  assert.deepEqual(
    await resolveMcpLaunch(launcher, original.args, env, 'win32'),
    original,
  )
})

test('native executables and Unix launchers keep their arguments', async (t) => {
  const { launcher, env } = installation(t)
  const args = ['a^b', '%PATH%']
  assert.deepEqual(
    await resolveMcpLaunch(process.execPath, args, env, 'win32'),
    {
      command: process.execPath,
      args,
    },
  )
  for (const platform of ['darwin', 'linux'])
    assert.deepEqual(await resolveMcpLaunch(launcher, args, env, platform), {
      command: launcher,
      args,
    })
})

test('Windows resolves a current-directory wrapper before PATH npm', async (t) => {
  const { env } = installation(t)
  const cwd = mkdtempSync(join(tmpdir(), 'custom npm cwd '))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'npx.cmd'), '@echo off\r\necho custom wrapper\r\n')
  const moduleUrl = new URL('../dist/mcp/launch.js', import.meta.url).href
  const source = `import { resolveMcpLaunch } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await resolveMcpLaunch('npx', ['a^b'], ${JSON.stringify(env)}, 'win32')))`
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', source],
    { cwd, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { command: 'npx', args: ['a^b'] })
})

test('Windows npm uses adjacent Node before PATH and bundled Node', async (t) => {
  const { launcher, cli, env } = installation(t)
  const sibling = join(dirname(launcher), 'node.exe')
  writeFileSync(sibling, 'fixture')
  assert.deepEqual(await resolveMcpLaunch(launcher, [], env, 'win32'), {
    command: sibling,
    args: [cli],
  })
})

test('official prefix lookup selects validated global npm and falls back on failure', async (t) => {
  const { launcher, cli, packageDirectory, env } = installation(t)
  const prefix = mkdtempSync(join(tmpdir(), 'npm global prefix '))
  t.after(() => rmSync(prefix, { recursive: true, force: true }))
  const global = npmInstallation(prefix, 'npx.cmd')
  const prefixScript = join(packageDirectory, 'bin', 'npm-prefix.js')
  writeFileSync(
    launcher,
    '@echo off\r\nREM npm-prefix.js\r\nnode "%~dp0node_modules\\npm\\bin\\npx-cli.js" %*\r\n',
  )
  writeFileSync(prefixScript, `process.stdout.write(${JSON.stringify(prefix)})`)
  assert.deepEqual(await resolveMcpLaunch(launcher, ['a^b'], env, 'win32'), {
    command: process.execPath,
    args: [global.cli, 'a^b'],
  })
  writeFileSync(
    join(global.packageDirectory, 'package.json'),
    JSON.stringify({ name: 'other' }),
  )
  assert.deepEqual(await resolveMcpLaunch(launcher, [], env, 'win32'), {
    command: process.execPath,
    args: [cli],
  })
  writeFileSync(prefixScript, 'process.exit(1)')
  assert.deepEqual(await resolveMcpLaunch(launcher, [], env, 'win32'), {
    command: process.execPath,
    args: [cli],
  })
})

test(
  'hanging prefix lookup is bounded and falls back to local npm',
  { timeout: 15000 },
  async (t) => {
    const { launcher, cli, packageDirectory, env } = installation(t)
    writeFileSync(
      launcher,
      '@echo off\r\nREM npm-prefix.js\r\nnode "%~dp0node_modules\\npm\\bin\\npx-cli.js" %*\r\n',
    )
    writeFileSync(
      join(packageDirectory, 'bin', 'npm-prefix.js'),
      'setInterval(() => {}, 1000)',
    )
    assert.deepEqual(await resolveMcpLaunch(launcher, [], env, 'win32'), {
      command: process.execPath,
      args: [cli],
    })
  },
)
