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

test('Agent page opens and receives native bounds while animation frames are suspended; idle has no polling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-background-'))
  const server = createServer()
  let browser
  try {
    await build({
      absWorkingDir: desktop,
      stdin: {
        contents: `
          import React, { useRef, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { useBrowserNavigationFailure } from './frontend/features/browser/useBrowserNavigationFailure';
          import { BrowserNavigationFailure } from './frontend/features/browser/BrowserNavigationFailure';
          import { setBrowserPanelOpen } from './frontend/features/browser/panel-state';
          import { useBrowserSurface } from './frontend/features/browser/useBrowserSurface';
          import { useBrowserViewport } from './frontend/features/browser/useBrowserViewport';
          import { useBrowserPanelOpen } from './frontend/features/browser/panel-state';
          window.requestAnimationFrame = () => 1;
          function Fixture() {
            const [slot, setSlot] = useState(true);
            window.replaceSlot = setSlot;
            const [session, setSession] = useState('active');
            const navigation = useBrowserNavigationFailure(session);
            window.switchSession = setSession;
            window.closePanel = () => setBrowserPanelOpen(false);
            const open = useBrowserPanelOpen();
            const { state } = useBrowserSurface(open);
            const ref = useRef(null);
            useBrowserViewport(ref, open && !navigation.failure, state?.available === true, state?.activeTabId ?? null);
            return <div data-session={session} data-open={open}>{slot && <div ref={ref} style={{width: 400, height: 300}} />}{navigation.failure && <BrowserNavigationFailure failure={navigation.failure} onDismiss={navigation.dismiss} />}</div>;
          }
          const root = createRoot(document.getElementById('root'));
          root.render(<Fixture />);
          window.unmount = () => root.unmount();`,
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
            build.onLoad({ filter: /api[/\\]browser\.ts$/ }, () => ({
              loader: 'js',
              contents: `
            let state = {revision: 0, available: true, tabs: [], activeTabId: null, status: 'idle'};
            window.layouts = [];
            export const browserSurface = {
              subscribe: async listener => { window.emit = () => listener(state = {...state, revision: 1, activeTabId: 1, tabs: [{id: 1, control: 'agent', status: 'ready', url: 'https://example.com'}]}); return () => {}; },
              control: async action => { if (action.kind === 'layout') window.layouts.push(action); return state; }
            };
            export const browserSession = {attach: async () => state};
          `,
            }))
            build.onLoad({ filter: /api[/\\]browser-navigation\.ts$/ }, () => ({
              loader: 'js',
              contents: `export const subscribeBrowserNavigation = listener => {window.emitNavigation = listener; window.navigationSubscriptions = (window.navigationSubscriptions ?? 0) + 1; return () => {window.emitNavigation = () => {}; window.navigationSubscriptions--;};};`,
            }))
            build.onLoad({ filter: /api[/\\]browser-settings\.ts$/ }, () => ({
              loader: 'js',
              contents: `export const useBrowserSettings = () => ({mode: 'embedded', storageMode: 'temporary', saveHistory: false});`,
            }))
            build.onLoad({ filter: /api[/\\]browser-data\.ts$/ }, () => ({
              loader: 'js',
              contents: `export const recordBrowserVisit = async () => {};`,
            }))
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
          : '<main id="root"></main><script src="/app.js"></script>',
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
    // The fixture deliberately suspends RAF; the observer must not depend on it.
    await page.waitForFunction(() => typeof window.emit === 'function', null, {
      polling: 50,
    })
    await page.evaluate(() => window.emit())
    await page.locator('[data-open="true"]').waitFor()
    await page.waitForFunction(
      () =>
        window.layouts.some(
          (layout) =>
            layout.visible && layout.width === 400 && layout.height === 300,
        ),
      null,
      { polling: 50 },
    )
    const count = await page.evaluate(() => window.layouts.length)
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(await page.evaluate(() => window.layouts.length), count)
    // Native dialogs have an implicit role; opening an already mounted dialog
    // must hide the native webpage, and closing it must restore the viewport.
    await page.evaluate(() => {
      const dialog = document.createElement('dialog')
      dialog.id = 'task-details'
      document.body.append(dialog)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await page.evaluate(() => window.layouts.length), count)
    await page.evaluate(() =>
      document.getElementById('task-details').showModal(),
    )
    await page.waitForFunction(() => !window.layouts.at(-1).visible, null, {
      polling: 50,
    })
    await page.evaluate(() => document.getElementById('task-details').close())
    await page.waitForFunction(() => window.layouts.at(-1).visible, null, {
      polling: 50,
    })
    await page.evaluate(() => document.getElementById('task-details').remove())
    // Retained hidden dialog content must not keep the browser hidden.
    await page.evaluate(() => {
      const dialog = document.createElement('dialog')
      dialog.id = 'retained'
      dialog.innerHTML = '<section role="alertdialog">confirmation</section>'
      document.body.append(dialog)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await page.evaluate(() => window.layouts.at(-1).visible), true)
    await page.evaluate(() => document.getElementById('retained').remove())
    for (const selector of [
      'role="dialog"',
      'role="alertdialog"',
      'aria-modal="true"',
      'data-radix-popper-content-wrapper',
      'data-browser-occluder',
      'role="menu"',
      'role="listbox"',
      'role="tooltip"',
    ]) {
      await page.evaluate((attribute) => {
        const holder = document.createElement('div')
        holder.id = 'overlay-holder'
        holder.hidden = true
        holder.innerHTML = `<div ${attribute} style="position:fixed;left:20px;top:20px;width:100px;height:100px">overlay</div>`
        document.body.append(holder)
      }, selector)
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(
        await page.evaluate(() => window.layouts.at(-1).visible),
        true,
      )
      await page.evaluate(() => {
        document.getElementById('overlay-holder').hidden = false
      })
      await page.waitForFunction(() => !window.layouts.at(-1).visible, null, {
        polling: 50,
      })
      await page.evaluate(() => {
        document.getElementById('overlay-holder').style.display = 'none'
      })
      await page.waitForFunction(() => window.layouts.at(-1).visible, null, {
        polling: 50,
      })
      await page.evaluate(() =>
        document.getElementById('overlay-holder').remove(),
      )
    }
    await page.evaluate(() => window.replaceSlot(false))
    await page.waitForFunction(() => !window.layouts.at(-1).visible, null, {
      polling: 50,
    })
    await page.evaluate(() => window.replaceSlot(true))
    await page.waitForFunction(() => window.layouts.at(-1).visible, null, {
      polling: 50,
    })
    await page.evaluate(() => {
      const slot = document.querySelector('[data-session] > div')
      slot.style.width = '350px'
    })
    await page.waitForFunction(
      () => window.layouts.at(-1).width === 350,
      null,
      {
        polling: 50,
      },
    )
    await page.evaluate(() => {
      const notice = document.createElement('div')
      notice.id = 'notice'
      notice.dataset.browserOccluder = ''
      notice.style.cssText =
        'position:fixed;left:800px;top:20px;width:100px;height:100px'
      document.body.append(notice)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await page.evaluate(() => window.layouts.at(-1).visible), true)
    await page.evaluate(() => document.getElementById('notice').remove())
    const failure = {
      toolCallId: 'denied-1',
      status: 'failed',
      errorCode: 'browser_network_denied',
      navigation: {
        sessionId: 'child',
        rootSessionId: 'active',
        url: 'https://example.com/search?q=test',
        message: 'DNS 返回私有或保留地址，导航未执行。',
      },
    }
    await page.evaluate(() => window.closePanel())
    await page.locator('[data-open="false"]').waitFor()
    await page.evaluate((event) => window.emitNavigation(event), {
      ...failure,
      navigation: { ...failure.navigation, rootSessionId: 'other' },
    })
    assert.equal(await page.getByRole('alert').count(), 0)
    await page.evaluate((event) => window.emitNavigation(event), failure)
    await page.locator('[data-open="true"]').waitFor()
    await page.getByRole('heading', { name: '导航被拦截' }).waitFor()
    assert.match(await page.getByRole('alert').innerText(), /example.com/)
    await page.waitForFunction(
      () => window.layouts.at(-1).visible === false,
      null,
      { polling: 50 },
    )
    await page.getByRole('button', { name: '返回浏览器' }).click()
    await page.evaluate(() => window.closePanel())
    await page.locator('[data-open="false"]').waitFor()
    await page.evaluate((event) => window.emitNavigation(event), failure)
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.equal(await page.locator('[data-open="false"]').count(), 1)
    await page.evaluate((event) => window.emitNavigation(event), {
      ...failure,
      toolCallId: 'denied-2',
    })
    await page.getByRole('alert').waitFor()
    await page.evaluate((event) => window.emitNavigation(event), {
      ...failure,
      toolCallId: 'success-3',
      status: 'completed',
    })
    await page.getByRole('alert').waitFor({ state: 'detached' })
    await page.evaluate((event) => window.emitNavigation(event), {
      ...failure,
      toolCallId: 'denied-4',
    })
    await page.getByRole('alert').waitFor()
    await page.evaluate(() => window.switchSession('other'))
    await page.getByRole('alert').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.navigationSubscriptions), 1)
    await page.evaluate(() => window.unmount())
    assert.equal(await page.evaluate(() => window.navigationSubscriptions), 0)
    assert.equal(
      await page.evaluate(() => window.layouts.at(-1).visible),
      false,
    )
  } finally {
    await browser?.close()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
