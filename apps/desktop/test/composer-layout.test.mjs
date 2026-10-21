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

async function assertComposerAccessible(page) {
  const boxes = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
    }
    const send = document.querySelector('.composer-send')
    const r = send.getBoundingClientRect()
    return {
      composer: rect('.composer'),
      textarea: rect('.composer textarea'),
      terminal: rect('.terminal-panel'),
      column: rect('.main-chat-column'),
      hit: send.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      ),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
  assert.ok(boxes.composer.top >= boxes.column.top, JSON.stringify(boxes))
  assert.ok(boxes.composer.bottom <= boxes.terminal.top, JSON.stringify(boxes))
  assert.ok(boxes.composer.right <= boxes.column.right, JSON.stringify(boxes))
  assert.ok(boxes.textarea.bottom > boxes.textarea.top, JSON.stringify(boxes))
  assert.equal(boxes.hit, true, 'send button must remain unobstructed')
  assert.equal(boxes.overflow, false)
}

test('composer stays accessible while browser, terminal and window are resized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'composer-layout-'))
  const server = createServer()
  let browser
  try {
    await build({
      absWorkingDir: desktop,
      entryPoints: ['test/fixtures/composer-layout.tsx'],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      outfile: join(directory, 'app.js'),
      define: { 'import.meta.env.VITE_TERMINAL_DISABLED': '"0"' },
      plugins: [
        {
          name: 'surface-boundaries',
          setup(build) {
            build.onLoad(
              {
                filter:
                  /(?:FileViewerPanel|BrowserSurfacePanel|SettingsView|InstructionsView|SkillsView|AgentRolesView|CollaborationPanel)\.tsx$/,
              },
              ({ path }) => {
                const name = path.split(/[\\/]/).at(-1).replace('.tsx', '')
                return {
                  contents: `export function ${name}(){return <div>面板内容</div>}`,
                  loader: 'tsx',
                }
              },
            )
            // Keep real terminal rendering and drag handling; isolate OS shell creation.
            build.onLoad(
              { filter: /features[\\/]terminal[\\/]manager\.ts$/ },
              () => ({
                contents: `
              let snapshot = {heightPx: 280, tabs: [], activeId: null};
              const listeners = new Set();
              export const PANEL_MIN_HEIGHT = 120, PANEL_MAX_VH = 0.6;
              export const terminalManager = {
                subscribe: (fn) => {listeners.add(fn); return () => listeners.delete(fn)},
                getSnapshot: () => snapshot,
                attachSlot() {}, detachSlot() {},
                setPanelHeight(heightPx) {snapshot = {...snapshot, heightPx}; for (const fn of listeners) fn()},
              };
            `,
                loader: 'ts',
              }),
            )
          },
        },
      ],
    })
    const script = await readFile(join(directory, 'app.js'))
    const css = await readFile(join(directory, 'app.css'))
    server.on('request', (request, response) => {
      response.setHeader(
        'content-type',
        request.url === '/app.js'
          ? 'text/javascript'
          : request.url === '/app.css'
            ? 'text/css'
            : 'text/html',
      )
      response.end(
        request.url === '/app.js'
          ? script
          : request.url === '/app.css'
            ? css
            : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>',
      )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({
      viewport: { width: 1440, height: 800 },
    })
    page.setDefaultTimeout(10000)
    const url = `http://127.0.0.1:${server.address().port}`
    for (const mode of ['', '?standalone', '?chat', '?no-provider']) {
      await page.goto(url + mode)
      await page
        .getByRole('button', { name: '对话工具菜单', exact: true })
        .click()
      await page
        .getByRole('menuitemcheckbox', { name: '网页浏览', exact: true })
        .click()
      const draft = Array.from(
        { length: 12 },
        (_, i) => `第 ${i + 1} 行输入内容`,
      ).join('\n')
      if (mode !== '?no-provider')
        await page.locator('.composer textarea').fill(draft)
      for (const size of [
        { width: 1440, height: 800 },
        { width: 1100, height: 640 },
        { width: 940, height: 600 },
      ]) {
        await page.setViewportSize(size)
        await assertComposerAccessible(page)
        const handle = page.getByRole('separator', {
          name: '调整面板宽度',
          exact: true,
        })
        await handle.focus()
        for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft')
        await assertComposerAccessible(page)
        // The separator has a tooltip rather than an accessible label.
        const bounds = await page
          .locator('.terminal-resize-handle')
          .boundingBox()
        await page.mouse.move(bounds.x + 20, bounds.y + 2)
        await page.mouse.down()
        await page.mouse.move(bounds.x + 20, 80, { steps: 8 })
        await page.mouse.up()
        await assertComposerAccessible(page)
        const capped = await page.locator('.terminal-panel').boundingBox()
        const start = await page
          .locator('.terminal-resize-handle')
          .boundingBox()
        await page.mouse.move(start.x + 20, start.y + 2)
        await page.mouse.down()
        await page.mouse.move(start.x + 20, start.y + 62, { steps: 4 })
        await page.mouse.up()
        const shrunk = await page.locator('.terminal-panel').boundingBox()
        assert.ok(
          Math.abs(capped.height - shrunk.height - 60) <= 1,
          'terminal drag starts from its displayed height after automatic clamping',
        )
        await assertComposerAccessible(page)
        if (mode !== '?no-provider')
          assert.equal(
            await page.locator('.composer textarea').inputValue(),
            draft,
          )
      }
      if (process.env.UI_REVIEW_OUTPUT)
        await page.screenshot({
          path: join(
            process.env.UI_REVIEW_OUTPUT,
            `composer-layout-${mode.slice(1) || 'project'}.png`,
          ),
        })
      if (mode !== '?no-provider') {
        await page.locator('.composer textarea').fill('布局调整后继续发送')
        await assertComposerAccessible(page)
        await page.getByRole('button', { name: '发送', exact: true }).click()
        await page.waitForFunction(
          () =>
            document.getElementById('sent').textContent ===
            '布局调整后继续发送',
        )
      }
    }
    if (process.env.UI_REVIEW_OUTPUT)
      await page.screenshot({
        path: join(
          process.env.UI_REVIEW_OUTPUT,
          'composer-terminal-layout.png',
        ),
      })
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
