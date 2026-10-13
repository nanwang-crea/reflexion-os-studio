import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, chmod, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserRuntimeService } from '../dist/browser/agent/runtime/service.js'
import { runBrowserInstaller } from '../dist/browser/agent/runtime/process.js'
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
  const browser = new BrowserAgentService({
    dataDir: dir,
    browserSettings: {
      get: () => ({
        agentBrowserEnabled: true,
        agentBrowserDisplay: 'headless',
      }),
    },
  })
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
