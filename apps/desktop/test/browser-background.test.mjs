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
          import React, { useRef } from 'react';
          import { createRoot } from 'react-dom/client';
          import { useBrowserSurface } from './frontend/features/browser/useBrowserSurface';
          import { useBrowserViewport } from './frontend/features/browser/useBrowserViewport';
          import { useBrowserPanelOpen } from './frontend/features/browser/panel-state';
          window.requestAnimationFrame = () => 1;
          function Fixture() {
            const open = useBrowserPanelOpen();
            const { state } = useBrowserSurface(open);
            const ref = useRef(null);
            useBrowserViewport(ref, open, state?.available === true, state?.activeTabId ?? null);
            return <div ref={ref} style={{width: 400, height: 300}} data-open={open} />;
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
    await page.evaluate(() => window.unmount())
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
