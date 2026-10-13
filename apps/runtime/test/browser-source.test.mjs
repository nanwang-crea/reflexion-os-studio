import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserRuntimeService } from '../dist/browser/agent/runtime/service.js'
import { systemChromeCandidates } from '../dist/browser/agent/runtime/sources/chrome.js'
import { launchAgentBrowser } from '../dist/browser/agent/worker/launch.js'

test('Chrome detection is limited to program locations on all three platforms', () => {
  assert.deepEqual(systemChromeCandidates('darwin', '/Users/example', {}), [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Users/example/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ])
  assert.deepEqual(
    systemChromeCandidates('win32', 'C:\\Users\\example', {
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
    }),
    [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\example\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ],
  )
  assert.deepEqual(
    systemChromeCandidates('win32', '', { ProgramFiles: 'relative' }),
    [],
  )
  const linux = systemChromeCandidates('linux', '/home/example', {})
  assert.ok(linux.includes('/opt/google/chrome/chrome'))
  assert.equal(
    linux.some((path) => /profile|User Data|\.config/.test(path)),
    false,
  )
  assert.deepEqual(systemChromeCandidates('freebsd', '', {}), [])
})

test('source choices resolve independently of installation; auto fallback requires installed managed component', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = {
    root,
    browsers: join(root, 'managed'),
    version: 'fixture',
    cli: 'unused',
    probe: 'unused',
  }
  let chrome = '/fixture/chrome'
  let downloads = 0
  const service = new BrowserRuntimeService(
    root,
    async () => {
      downloads++
      return ''
    },
    paths,
    () => chrome,
  )
  assert.equal(service.status.systemChromeAvailable, true)
  assert.equal(service.resolveLaunch('auto').launch.channel, 'chrome')
  assert.equal(service.resolveLaunch('auto').launch.fallbackManaged, false)
  assert.equal(
    service.resolveLaunch('system-chrome').launch.executablePath,
    chrome,
  )
  assert.throws(() => service.resolveLaunch('managed'), /not_installed/)
  assert.equal(downloads, 0)
  await mkdir(paths.browsers)
  await writeFile(join(paths.browsers, 'chrome'), 'fixture')
  await chmod(join(paths.browsers, 'chrome'), 0o755)
  await writeFile(
    join(paths.browsers, 'installed.json'),
    JSON.stringify({ version: 'fixture', executable: 'chrome' }),
  )
  assert.equal(service.resolveLaunch('auto').launch.fallbackManaged, true)
  assert.equal(
    service.resolveLaunch('system-chrome').launch.fallbackManaged,
    false,
  )
  assert.deepEqual(service.resolveLaunch('managed'), {
    browsers: paths.browsers,
    launch: { channel: 'chromium', fallbackManaged: false },
  })
  chrome = null
  assert.equal(service.status.systemChromeAvailable, false)
  assert.equal(service.resolveLaunch('auto').launch.channel, 'chromium')
  assert.throws(
    () => service.resolveLaunch('system-chrome'),
    /browser_system_chrome_unavailable/,
  )
  await rm(paths.browsers, { recursive: true })
  assert.throws(() => service.resolveLaunch('auto'), /not_installed/)
  assert.equal(downloads, 0)
})

test('fallback preserves sandbox and proxy and never reuses the Chrome executable override', async () => {
  const options = {
    headless: true,
    chromiumSandbox: true,
    proxy: { server: 'http://fixture' },
    args: ['--disable-quic'],
  }
  const calls = []
  const result = await launchAgentBrowser(
    {
      channel: 'chrome',
      executablePath: '/fixture/chrome',
      fallbackManaged: true,
    },
    options,
    () => true,
    async (options) => {
      calls.push(options)
      if (calls.length === 1) throw new Error('Chrome failed')
      return 'managed'
    },
  )
  assert.equal(result, 'managed')
  assert.deepEqual(calls[1], { ...options, channel: 'chromium' })
  assert.equal(calls[0].executablePath, '/fixture/chrome')
})

test('explicit Chrome failures and cancellation cannot launch a fallback', async () => {
  for (const [fallbackManaged, current, expected] of [
    [false, true, 'browser_system_chrome_unavailable'],
    [true, false, 'browser_closed'],
  ]) {
    let calls = 0
    await assert.rejects(
      launchAgentBrowser(
        { channel: 'chrome', fallbackManaged },
        {},
        () => current,
        async () => {
          calls++
          throw new Error('untrusted diagnostic')
        },
      ),
      new RegExp(expected),
    )
    assert.equal(calls, 1)
  }
})

test('auto source cannot use a managed cache while its installation task is in progress', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-source-pending-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = {
    root,
    browsers: join(root, 'managed'),
    version: 'fixture',
    cli: 'unused',
    probe: 'unused',
  }
  const service = new BrowserRuntimeService(
    root,
    async (_script, _args, _cache, signal) => {
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(new Error('cancelled'))
        else
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          )
      })
      return ''
    },
    paths,
    () => '/fixture/chrome',
  )
  service.install()
  await mkdir(paths.browsers)
  await writeFile(join(paths.browsers, 'chrome'), 'fixture')
  await chmod(join(paths.browsers, 'chrome'), 0o755)
  await writeFile(
    join(paths.browsers, 'installed.json'),
    JSON.stringify({ version: 'fixture', executable: 'chrome' }),
  )
  assert.equal(service.status.state, 'downloading')
  assert.equal(service.resolveLaunch('auto').launch.fallbackManaged, false)
  assert.throws(() => service.resolveLaunch('managed'), /not_installed/)
  await service.shutdown()
})
