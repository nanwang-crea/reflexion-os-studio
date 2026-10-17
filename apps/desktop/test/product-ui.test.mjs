import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
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

test('composer actions remain aligned in both themes and narrow split layouts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'product-ui-'))
  const server = createServer()
  let browser
  try {
    await build({
      absWorkingDir: desktop,
      entryPoints: ['test/fixtures/product-ui.tsx'],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      outfile: join(directory, 'app.js'),
      define: { 'import.meta.env.VITE_TERMINAL_DISABLED': '"0"' },
      plugins: [
        {
          name: 'isolated-project-files',
          setup(build) {
            build.onLoad({ filter: /\/ProjectFiles\.tsx$/ }, () => ({
              contents: 'export function ProjectFiles(){return null}',
              loader: 'tsx',
            }))
          },
        },
      ],
    })
    server.on('request', async (request, response) => {
      const path = new URL(request.url, 'http://fixture').pathname
      if (path === '/app.js' || path === '/app.css') {
        response.setHeader(
          'Content-Type',
          path.endsWith('.js') ? 'application/javascript' : 'text/css',
        )
        response.end(await readFile(join(directory, path.slice(1))))
      } else
        response.end(
          '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>',
        )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const url = `http://127.0.0.1:${server.address().port}`
    for (const theme of ['light', 'dark'])
      for (const width of [1440, 940]) {
        await page.setViewportSize({ width, height: 860 })
        await page.goto(`${url}?theme=${theme}`)
        await page.waitForSelector('.composer-send')
        const boxes = await page.evaluate(() => {
          const box = (selector) => {
            const r = document.querySelector(selector).getBoundingClientRect()
            return { left: r.left, right: r.right, bottom: r.bottom }
          }
          return {
            composer: box('.composer'),
            send: box('.composer-send'),
            controls: box('.composer-controls'),
            overflow: document.documentElement.scrollWidth > innerWidth,
          }
        })
        assert.equal(boxes.overflow, false)
        assert.ok(boxes.send.right <= boxes.composer.right)
        assert.ok(boxes.send.right >= boxes.composer.right - 18)
        assert.ok(boxes.controls.right <= boxes.send.left)
        assert.equal(
          await page.getByRole('combobox', { name: '对话思考强度' }).count(),
          0,
        )
        await page
          .getByRole('combobox', { name: '对话模型', exact: true })
          .click()
        await page.getByRole('listbox').waitFor()
        await page.keyboard.press('Escape')
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute('aria-label') === '对话模型',
        )
        if (process.env.UI_REVIEW_OUTPUT) {
          await mkdir(process.env.UI_REVIEW_OUTPUT, { recursive: true })
          await page.screenshot({
            animations: 'disabled',
            path: join(
              process.env.UI_REVIEW_OUTPUT,
              `main-${theme}-${width}.png`,
            ),
          })
        }
      }
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置分类' }).waitFor()
    await page.getByRole('radio', { name: /^浅色/ }).check()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
    if (process.env.UI_REVIEW_OUTPUT)
      await page.screenshot({
        animations: 'disabled',
        path: join(process.env.UI_REVIEW_OUTPUT, 'settings-light.png'),
      })
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
