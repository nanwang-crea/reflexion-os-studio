import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { browserWorkerPaths } from '../../runtime/dist/browser/agent/paths.js'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(
  new URL('../../runtime/package.json', import.meta.url),
)
process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { chromium } = require('playwright')

test('settings install flow shows progress, supports cancellation and stops idle polling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-component-ui-'))
  let browser
  const server = createServer()
  try {
    await build({
      absWorkingDir: desktop,
      stdin: {
        contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { AgentBrowserSettingsPanel } from './frontend/features/settings/agent-browser/AgentBrowserSettingsPanel'; const root = createRoot(document.getElementById('root')); root.render(React.createElement(AgentBrowserSettingsPanel)); window.unmount = () => root.unmount();`,
        resolveDir: desktop,
        loader: 'tsx',
      },
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      outfile: join(directory, 'app.js'),
      plugins: [
        {
          name: 'fixture-api',
          setup(build) {
            build.onLoad(
              { filter: /api[/\\]agent-browser-settings\.ts$/ },
              () => ({
                contents: `
            let state = { state: 'not-installed', phase: 'idle', progress: null, version: 'fixture', error: null, systemChromeAvailable: true };
            window.requests = { status: 0, install: 0, cancel: 0, sources: [], lifetimes: [], closed: 0 };
            let settings = { enabled: false, source: 'auto', display: 'headless', approval: 'follow-session', lifetime: 'session' };
            export async function getAgentBrowserSettings() { return { ...settings }; }
            export async function updateAgentBrowserSettings(next) { settings = next; window.requests.sources.push(next.source); window.requests.lifetimes.push(next.lifetime); return { ...settings }; }
            export async function closeAgentBrowserWindows() { window.requests.closed++; }
            export async function getAgentBrowserRuntime() { window.requests.status++; const snapshot = { ...state }; if (window.holdNextStatus) { window.holdNextStatus = false; return new Promise(resolve => window.releaseStatus = () => resolve(snapshot)); } return snapshot; }
            export async function installAgentBrowserRuntime() { window.requests.install++; state = { ...state, state: 'downloading', phase: 'download', progress: 25 }; return { ...state }; }
            export async function cancelAgentBrowserRuntime() { window.requests.cancel++; state = { ...state, state: 'failed', phase: 'failed', error: 'download-cancelled' }; return { ...state }; }
            window.corruptManager = () => state = { ...state, state: 'not-installed', error: 'runtime-unavailable' };
            window.complete = () => state = { ...state, state: 'installed', phase: 'ready', progress: null, error: null };
          `,
                loader: 'js',
              }),
            )
          },
        },
      ],
    })
    const script = await readFile(join(directory, 'app.js'))
    server.on('request', (request, response) => {
      response.setHeader(
        'content-type',
        request.url === '/app.js' ? 'text/javascript' : 'text/html',
      )
      response.end(
        request.url === '/app.js'
          ? script
          : '<meta charset="utf-8"><main id="root"></main><script src="/app.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      chromiumSandbox: true,
    })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page
      .getByRole('button', { name: '下载浏览器组件', exact: true })
      .waitFor()
    await page
      .getByText('已检测到本机 Chrome，自动模式下无需下载。', { exact: true })
      .waitFor()
    assert.equal(await page.evaluate(() => window.requests.install), 0)
    await page
      .getByRole('combobox', { name: 'Agent 浏览器来源', exact: true })
      .click()
    await page
      .getByRole('option', { name: '仅本机 Chrome', exact: true })
      .click()
    assert.deepEqual(await page.evaluate(() => window.requests.sources), [
      'system-chrome',
    ])
    await page
      .getByRole('combobox', { name: 'Agent 浏览器保留方式', exact: true })
      .click()
    await page
      .getByRole('option', {
        name: '关闭浏览器，每次回复重新打开',
        exact: true,
      })
      .click()
    assert.equal(
      await page.evaluate(() => window.requests.lifetimes.at(-1)),
      'run',
    )
    await page
      .getByRole('button', { name: '关闭所有 Agent 浏览器窗口', exact: true })
      .click()
    assert.equal(await page.evaluate(() => window.requests.closed), 1)
    await page
      .getByRole('button', { name: '下载浏览器组件', exact: true })
      .click()
    assert.equal(
      await page.getByRole('progressbar').getAttribute('value'),
      '25',
    )
    await page.evaluate(() => (window.holdNextStatus = true))
    await page.waitForFunction(() => typeof window.releaseStatus === 'function')
    await page.getByRole('button', { name: '取消下载' }).click()
    await page.getByText('下载已取消', { exact: true }).waitFor()
    await page.evaluate(() => window.releaseStatus())
    await page.getByText('下载已取消', { exact: true }).waitFor()
    await page.getByRole('button', { name: '重新下载' }).click()
    await page.evaluate(() => window.complete())
    await page.getByText('已安装', { exact: true }).waitFor()
    const requests = await page.evaluate(() => window.requests.status)
    await new Promise((resolve) => setTimeout(resolve, 1250))
    assert.equal(await page.evaluate(() => window.requests.status), requests)
    await page.evaluate(() => window.corruptManager())
    await page.getByRole('button', { name: '重新检查', exact: true }).click()
    await page
      .getByText('浏览器组件管理程序不可用，请重新安装应用。', { exact: true })
      .waitFor()
    assert.equal(
      await page
        .getByRole('button', { name: '下载浏览器组件', exact: true })
        .isDisabled(),
      true,
    )
    await page.evaluate(() => window.unmount())
    assert.equal(await page.evaluate(() => window.requests.install), 2)
    assert.equal(await page.evaluate(() => window.requests.cancel), 1)
  } finally {
    await browser?.close()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
