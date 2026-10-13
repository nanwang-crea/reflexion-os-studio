import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, chmod, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserRuntimeService } from '../dist/browser/agent/runtime/service.js'
import { runBrowserInstaller } from '../dist/browser/agent/runtime/installation/process.js'
import { BrowserAgentService } from '../dist/browser/agent/service.js'
import { agentBrowserSettingsCommandHandlers } from '../dist/browser/agent/handlers.js'

async function fixture(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'browser-component-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = {
    root,
    browsers: join(root, 'version-platform'),
    version: 'fixture-1',
    cli: 'fixture-cli',
    probe: 'fixture-probe',
  }
  return { paths, service: new BrowserRuntimeService(root, run, paths) }
}
async function finished(service) {
  for (let n = 0; n < 100 && service.status.state === 'downloading'; n++)
    await delay(5)
  assert.notEqual(service.status.state, 'downloading')
  return service.status
}
async function downloaded(script, args, root, signal, output) {
  signal.throwIfAborted()
  const executable = join(
    root,
    'chromium',
    process.platform === 'win32' ? 'chrome.exe' : 'chrome',
  )
  if (script === 'fixture-cli') {
    assert.deepEqual(args, ['install', 'chromium', '--no-shell'])
    await mkdir(join(root, 'chromium'), { recursive: true })
    await writeFile(executable, 'fixture')
    await chmod(executable, 0o755)
    output('Downloading fixture\r 40%\r 100%')
    return ''
  }
  return JSON.stringify({ executable })
}

test('no download until explicit request; duplicate requests share one task; installed cache survives restart', async (t) => {
  let calls = 0
  const { service, paths } = await fixture(t, async (...args) => {
    calls++
    return downloaded(...args)
  })
  assert.equal(service.status.state, 'not-installed')
  assert.equal(calls, 0)
  assert.throws(
    () => service.requireInstalled(),
    /browser_runtime_not_installed/,
  )
  assert.equal(service.install().state, 'downloading')
  assert.equal(service.install().state, 'downloading')
  assert.equal((await finished(service)).state, 'installed')
  assert.equal(calls, 2)
  assert.equal(service.requireInstalled(), paths.browsers)
  assert.equal(service.install().state, 'installed')
  assert.equal(calls, 2)
  const reopened = new BrowserRuntimeService(paths.root, downloaded, paths)
  assert.equal(reopened.status.state, 'installed')
  const updated = new BrowserRuntimeService(paths.root, downloaded, {
    ...paths,
    version: 'fixture-2',
  })
  assert.equal(updated.status.state, 'not-installed')
})

test('failed or cancelled downloads never publish partial components and allow retry', async (t) => {
  let fail = true
  const { service, paths } = await fixture(t, async (...args) => {
    if (fail) throw new Error('raw installer diagnostic that must not escape')
    return downloaded(...args)
  })
  service.install()
  assert.equal((await finished(service)).error, 'download-failed')
  assert.equal(service.status.state, 'failed')
  assert.deepEqual(await readdir(join(paths.root, 'staging')), [])
  fail = false
  service.install()
  assert.equal((await finished(service)).state, 'installed')
  await rm(join(paths.browsers, 'chromium'), { recursive: true })
  assert.equal(service.status.state, 'not-installed')
  const cancelled = await fixture(t, async (_script, _args, _root, signal) => {
    await delay(10, undefined, { signal })
    throw new Error('never publish')
  })
  cancelled.service.install()
  cancelled.service.cancel()
  await cancelled.service.shutdown()
  assert.equal(cancelled.service.status.error, 'download-cancelled')
  assert.deepEqual(await readdir(join(cancelled.paths.root, 'staging')), [])
})

test('probe cannot publish an executable outside its staging directory', async (t) => {
  const { service } = await fixture(t, async (script) =>
    script === 'fixture-cli'
      ? ''
      : JSON.stringify({ executable: process.execPath }),
  )
  service.install()
  assert.equal((await finished(service)).state, 'failed')
})

test('runtime management commands are explicit and do not enable browser tools', async (t) => {
  const { service } = await fixture(t, downloaded)
  const context = { browser: { runtime: service } }
  assert.equal(
    agentBrowserSettingsCommandHandlers['agent_browser_runtime.status'](
      {},
      context,
    ).runtime.state,
    'not-installed',
  )
  assert.equal(
    agentBrowserSettingsCommandHandlers['agent_browser_runtime.install'](
      {},
      context,
    ).runtime.state,
    'downloading',
  )
  await finished(service)
  assert.equal(
    agentBrowserSettingsCommandHandlers['agent_browser_runtime.status'](
      {},
      context,
    ).runtime.state,
    'installed',
  )
})

test('missing component produces actionable error before spawning a browser worker', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'missing-browser-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const browser = new BrowserAgentService(
    {
      dataDir: dir,
      browserSettings: {
        get: () => ({
          agentBrowserEnabled: true,
          agentBrowserDisplay: 'headless',
        }),
      },
    },
    undefined,
    new BrowserRuntimeService(dir, undefined, undefined, () => null),
  )
  await assert.rejects(
    browser.call(
      'session',
      'run',
      'navigate',
      { url: 'https://example.com' },
      new AbortController().signal,
    ),
    /browser_runtime_not_installed/,
  )
  await browser.shutdown()
})

test('installer subprocess captures stdout, preserves protocol stdout and is cancellable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'download-process-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const script = join(dir, 'fixture.mjs')
  await writeFile(
    script,
    "process.stdout.write('10%\\n'); if (process.argv.includes('wait')) setInterval(() => {}, 1000)",
  )
  const signal = new AbortController()
  let output = ''
  assert.equal(
    await runBrowserInstaller(
      script,
      [],
      dir,
      signal.signal,
      (chunk) => (output += chunk),
    ),
    '10%\n',
  )
  assert.equal(output, '10%\n')
  const cancellation = new AbortController()
  const running = runBrowserInstaller(
    script,
    ['wait'],
    dir,
    cancellation.signal,
    () => cancellation.abort(),
  )
  await assert.rejects(running, /download-cancelled/)
})

for (const stage of ['backup', 'publish']) {
  test(`installation cancellation during ${stage} restores the previous directory`, async (t) => {
    const { rename } = await import('node:fs/promises')
    const { publishBrowserInstallation } =
      await import('../dist/browser/agent/runtime/installation/publish.js')
    const root = await mkdtemp(join(tmpdir(), 'browser-publish-cancel-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const previous = join(root, 'installed')
    const staging = join(root, 'staging')
    await mkdir(previous)
    await writeFile(join(previous, 'old'), 'previous')
    await mkdir(staging)
    await writeFile(join(staging, 'new'), 'new')
    const controller = new AbortController()
    let calls = 0
    await assert.rejects(
      publishBrowserInstallation(
        staging,
        previous,
        controller.signal,
        async (from, to) => {
          await rename(from, to)
          calls++
          if (calls === (stage === 'backup' ? 1 : 2)) controller.abort()
        },
      ),
      { name: 'AbortError' },
    )
    assert.deepEqual(await readdir(previous), ['old'])
    assert.equal(
      (await readdir(root)).some((entry) => entry.startsWith('backup-')),
      false,
    )
  })
}

test('invalid staged executables cannot replace previous files', async (t) => {
  const { service, paths } = await fixture(t, async (script, args, staging) => {
    const executable = join(staging, 'not-executable')
    if (script === 'fixture-cli') {
      await writeFile(executable, 'invalid')
      await chmod(executable, 0o600)
      return ''
    }
    return JSON.stringify({ executable })
  })
  if (process.platform === 'win32') {
    t.skip('Windows executable permission semantics differ')
    return
  }
  await mkdir(paths.browsers)
  await writeFile(join(paths.browsers, 'previous'), 'preserve')
  service.install()
  assert.equal((await finished(service)).state, 'failed')
  assert.deepEqual(await readdir(paths.browsers), ['previous'])
})

test('installation inspection rejects symlinked markers, symlinked caches and oversized records', async (t) => {
  const { symlink } = await import('node:fs/promises')
  const { isBrowserInstallation } =
    await import('../dist/browser/agent/runtime/installation/record.js')
  const { service, paths } = await fixture(t, downloaded)
  service.install()
  await finished(service)
  const original = join(paths.browsers, 'installed.json')
  const saved = join(paths.root, 'saved-marker')
  const { rename } = await import('node:fs/promises')
  await rename(original, saved)
  await symlink(saved, original, 'file')
  assert.equal(isBrowserInstallation(paths.browsers, paths.version), false)
  await rm(original)
  await writeFile(original, ' '.repeat(4097))
  assert.equal(isBrowserInstallation(paths.browsers, paths.version), false)
  const linked = join(paths.root, 'linked-cache')
  await symlink(
    paths.browsers,
    linked,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  assert.equal(isBrowserInstallation(linked, paths.version), false)
})

test('publishing file operation failure restores the previous installation', async (t) => {
  const { rename } = await import('node:fs/promises')
  const { publishBrowserInstallation } =
    await import('../dist/browser/agent/runtime/installation/publish.js')
  const root = await mkdtemp(join(tmpdir(), 'browser-publish-failed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = join(root, 'installed')
  const staging = join(root, 'staging')
  await mkdir(previous)
  await writeFile(join(previous, 'old'), 'old')
  await mkdir(staging)
  await assert.rejects(
    publishBrowserInstallation(
      staging,
      previous,
      new AbortController().signal,
      async (from, to) => {
        if (from === staging) throw new Error('disk operation failed')
        await rename(from, to)
      },
    ),
    /disk operation failed/,
  )
  assert.deepEqual(await readdir(previous), ['old'])
})

test('post-move validation failure rolls back before installation is committed', async (t) => {
  const { publishBrowserInstallation } =
    await import('../dist/browser/agent/runtime/installation/publish.js')
  const root = await mkdtemp(join(tmpdir(), 'browser-publish-validation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = join(root, 'installed')
  const staging = join(root, 'staging')
  await mkdir(previous)
  await writeFile(join(previous, 'old'), 'old')
  await mkdir(staging)
  await writeFile(join(staging, 'new'), 'new')
  await assert.rejects(
    publishBrowserInstallation(
      staging,
      previous,
      new AbortController().signal,
      undefined,
      () => false,
    ),
    /download-failed/,
  )
  assert.deepEqual(await readdir(previous), ['old'])
})

test('a failed rollback retains the previous installation backup for recovery', async (t) => {
  const { rename } = await import('node:fs/promises')
  const { publishBrowserInstallation } =
    await import('../dist/browser/agent/runtime/installation/publish.js')
  const root = await mkdtemp(join(tmpdir(), 'browser-rollback-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = join(root, 'installed')
  const staging = join(root, 'staging')
  await mkdir(previous)
  await writeFile(join(previous, 'old'), 'old')
  await mkdir(staging)
  await assert.rejects(
    publishBrowserInstallation(
      staging,
      previous,
      new AbortController().signal,
      async (from, to) => {
        if (from === staging || from.endsWith('previous'))
          throw new Error('locked files')
        await rename(from, to)
      },
    ),
    /locked files/,
  )
  const backup = (await readdir(root)).find((entry) =>
    entry.startsWith('backup-'),
  )
  assert.ok(backup)
  assert.deepEqual(await readdir(join(root, backup, 'previous')), ['old'])
})
