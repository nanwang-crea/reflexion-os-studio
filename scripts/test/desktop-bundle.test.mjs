import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  utimes,
} from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stageWindowsBundle } from '../native/windows-bundle.mjs'
import { desktopBuildPaths } from '../desktop-build-paths.mjs'
import { verifyDesktopAssets } from '../verify-desktop-assets.mjs'

async function fixture(t, env = {}, profile = 'release') {
  const root = await mkdtemp(join(tmpdir(), 'desktop bundle '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const host = join(root, 'apps', 'desktop', 'src-tauri')
  const target = env.CARGO_TARGET_DIR
    ? join(host, env.CARGO_TARGET_DIR)
    : join(host, 'target')
  const directory = join(target, env.CARGO_BUILD_TARGET ?? '', profile)
  const executable = join(directory, 'reflexion-desktop.exe')
  const cache = join(root, '.cache', 'cef-native', 'windows')
  await mkdir(directory, { recursive: true })
  await mkdir(cache, { recursive: true })
  await writeFile(executable, 'original Rust executable')
  await writeFile(join(cache, 'bootstrap.exe'), 'CEF bootstrap')
  await writeFile(join(cache, 'reflexion-desktop.dll'), 'stale cache DLL')
  return { root, host, directory, executable, cache }
}

for (const debug of [false, true]) {
  test(`Windows ${debug ? 'debug' : 'release'} installer DLL retains embedded frontend assets`, async (t) => {
    const env = { TAURI_ENV_DEBUG: String(debug) }
    const f = await fixture(t, env, debug ? 'debug' : 'release')
    await stageWindowsBundle(f.root, env, (command, args, options) => {
      assert.equal(command, 'cargo')
      assert.ok(args.includes('--lib'))
      assert.ok(args.includes('tauri/custom-protocol'))
      assert.equal(args.includes('--release'), !debug)
      assert.equal(options.cwd, f.host)
      // Model the build-mode distinction which caused the real Windows failure.
      writeFileSync(
        join(f.directory, 'reflexion_desktop_lib.dll'),
        'DLL with embedded assets',
      )
      return { status: 0, signal: null }
    })
    assert.equal(await readFile(f.executable, 'utf8'), 'CEF bootstrap')
    assert.equal(
      await readFile(join(f.cache, 'reflexion-desktop.dll'), 'utf8'),
      'DLL with embedded assets',
    )
    assert.equal(
      await readFile(join(f.directory, 'reflexion-desktop.dll'), 'utf8'),
      'DLL with embedded assets',
    )
  })
}

test('explicit target and relative Cargo output use the same directory for DLL build and verification', async (t) => {
  const env = {
    CARGO_TARGET_DIR: 'custom target',
    CARGO_BUILD_TARGET: 'x86_64-pc-windows-msvc',
  }
  const f = await fixture(t, env)
  await stageWindowsBundle(f.root, env, (_command, args, options) => {
    assert.equal(args[args.indexOf('--target') + 1], env.CARGO_BUILD_TARGET)
    assert.equal(options.env.CARGO_TARGET_DIR, join(f.host, 'custom target'))
    writeFileSync(join(f.directory, 'reflexion_desktop_lib.dll'), 'embedded')
    return { status: 0 }
  })
  verifyDesktopAssets(f.root, env, 'win32', (executable, args, options) => {
    assert.equal(executable, f.executable)
    assert.deepEqual(args, ['--verify-frontend-assets'])
    assert.equal(options.cwd, f.directory)
    return { status: 0 }
  })
})

test('DLL build failure keeps the original executable and cached DLL intact', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    stageWindowsBundle(f.root, {}, () => ({ status: 1 })),
    /DLL build failed/,
  )
  assert.equal(await readFile(f.executable, 'utf8'), 'original Rust executable')
  assert.equal(
    await readFile(join(f.cache, 'reflexion-desktop.dll'), 'utf8'),
    'stale cache DLL',
  )
})

test('missing DLL is not replaced with a stale cached DLL or bootstrap', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    stageWindowsBundle(f.root, {}, () => ({ status: 0 })),
    /ENOENT/,
  )
  assert.equal(await readFile(f.executable, 'utf8'), 'original Rust executable')
})

test('explicit cross target cannot fall back to a stale native executable', async (t) => {
  const f = await fixture(t)
  assert.throws(
    () =>
      desktopBuildPaths(
        f.root,
        { CARGO_BUILD_TARGET: 'other-target' },
        'win32',
      ),
    /not found/,
  )
})

test('Tauri inferred target selects the latest compiled layout and preserves its target for the DLL', async (t) => {
  const f = await fixture(t)
  const triple = 'x86_64-pc-windows-msvc'
  const executable = join(
    f.host,
    'target',
    triple,
    'release',
    'reflexion-desktop.exe',
  )
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'cross build')
  await utimes(f.executable, 1, 1)
  const paths = desktopBuildPaths(
    f.root,
    { TAURI_ENV_TARGET_TRIPLE: triple },
    'win32',
  )
  assert.equal(paths.executable, executable)
  assert.equal(paths.triple, triple)
})

test('verification exposes Windows loader exit code, signals, and spawn errors', async (t) => {
  const f = await fixture(t)
  assert.throws(
    () =>
      verifyDesktopAssets(f.root, {}, 'win32', () => ({ status: -1073741515 })),
    /0xc0000135/,
  )
  assert.throws(
    () =>
      verifyDesktopAssets(f.root, {}, 'win32', () => ({
        status: null,
        signal: 'SIGTERM',
      })),
    /signal=SIGTERM/,
  )
  assert.throws(
    () =>
      verifyDesktopAssets(f.root, {}, 'win32', () => ({
        status: null,
        error: new Error('probe timeout'),
      })),
    /probe timeout/,
  )
})
