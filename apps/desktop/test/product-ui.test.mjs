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
            build.onLoad({ filter: /[\\/]ProjectFiles\.tsx$/ }, () => ({
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
    // Measure settled colors rather than an intermediate disabled→enabled transition.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const url = `http://127.0.0.1:${server.address().port}`
    if (process.env.UI_REVIEW_OUTPUT)
      await mkdir(process.env.UI_REVIEW_OUTPUT, { recursive: true })
    for (const theme of ['light', 'dark'])
      for (const width of [1440, 940]) {
        await page.setViewportSize({ width, height: 860 })
        await page.goto(`${url}?theme=${theme}`)
        await page.waitForSelector('.composer-send')
        await page
          .locator('.composer textarea')
          .fill('帮我梳理这个项目，先给出清晰的实现方案。')
        const colors = await page
          .locator('.composer-send')
          .evaluate((button) => {
            const style = getComputedStyle(button)
            const rgb = (value) =>
              value
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number)
            const luminance = (color) =>
              rgb(color)
                .map((v) => {
                  const c = v / 255
                  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
                })
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
            const a = luminance(style.color),
              b = luminance(style.backgroundColor)
            return {
              contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
              fill: rgb(style.backgroundColor),
            }
          })
        assert.ok(
          colors.contrast >= 4.5,
          `${theme}: action contrast ${colors.contrast}`,
        )
        assert.ok(
          colors.fill[2] > colors.fill[1] && colors.fill[1] > colors.fill[0],
          'primary action uses sky blue',
        )
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
          await page
            .getByRole('combobox', { name: '对话思考强度' })
            .isDisabled(),
          true,
        )
        await page
          .getByRole('button', { name: '对话模型', exact: true })
          .click()
        await page.getByRole('menuitem', { name: '示例供应商' }).waitFor()
        await page.getByRole('menuitem', { name: '示例供应商' }).focus()
        await page.keyboard.press('ArrowRight')
        const selected = page.getByRole('menuitemradio', {
          name: '示例模型 · 标准',
        })
        await selected.waitFor()
        assert.equal(await selected.getAttribute('aria-checked'), 'true')
        for (const menu of await page.locator('.ui-grouped-menu').all()) {
          const bounds = await menu.boundingBox()
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width)
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 860)
        }
        if (process.env.UI_REVIEW_OUTPUT)
          await page.screenshot({
            animations: 'disabled',
            path: join(
              process.env.UI_REVIEW_OUTPUT,
              `model-menu-${theme}-${width}.png`,
            ),
          })
        await page.keyboard.press('Escape')

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
    await page.getByRole('button', { name: '对话模型', exact: true }).click()
    await page.getByRole('menuitem', { name: '备用供应商' }).hover()
    await page
      .getByRole('menuitemradio', { name: '备用模型', exact: true })
      .click()
    assert.match(
      await page
        .getByRole('button', { name: '对话模型', exact: true })
        .innerText(),
      /备用模型/,
    )
    assert.equal(await page.locator('.ui-grouped-menu').count(), 0)
    await page.goto(`${url}?theme=light&many-models=1`)
    await page.getByRole('button', { name: '对话模型', exact: true }).click()
    await page.getByRole('menuitem', { name: '备用供应商' }).focus()
    await page.keyboard.press('ArrowRight')
    await page.getByRole('menuitemradio').first().waitFor()
    await page.keyboard.press('End')
    await page.waitForFunction(() =>
      document.activeElement?.textContent?.startsWith('长模型名称-49-'),
    )
    const longMenu = await page
      .getByRole('menu', { name: '备用供应商', exact: true })
      .boundingBox()
    assert.ok(longMenu.width <= 320)
    assert.ok(longMenu.height <= 360)
    assert.ok(longMenu.x >= 0 && longMenu.x + longMenu.width <= 940)
    await page.keyboard.press('Enter')
    assert.match(
      await page
        .getByRole('button', { name: '对话模型', exact: true })
        .innerText(),
      /长模型名称-49-/,
    )
    await page.goto(`${url}?theme=light&reasoning=supported`)
    const reasoning = page.getByRole('combobox', { name: '对话思考强度' })
    await reasoning.waitFor()
    assert.equal(await reasoning.isEnabled(), true)
    assert.match(await reasoning.innerText(), /思考：高/)
    await reasoning.click()
    await page.getByRole('option', { name: '思考：低', exact: true }).click()
    assert.match(await reasoning.innerText(), /思考：低/)
    for (const state of ['loading', 'error']) {
      await page.goto(`${url}?theme=dark&reasoning=${state}`)
      await reasoning.waitFor()
      assert.equal(await reasoning.isDisabled(), true)
      assert.match(
        await reasoning.innerText(),
        state === 'loading' ? /加载中/ : /加载失败/,
      )
    }
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('navigation', { name: '设置分类' }).waitFor()
    await page.getByRole('radio', { name: /^浅色/ }).check()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
    if (process.env.UI_REVIEW_OUTPUT) {
      await page.screenshot({
        animations: 'disabled',
        path: join(process.env.UI_REVIEW_OUTPUT, 'settings-light.png'),
      })
      await page.getByRole('radio', { name: /^深色/ }).check()
      await page.screenshot({
        animations: 'disabled',
        path: join(process.env.UI_REVIEW_OUTPUT, 'settings-dark.png'),
      })
    }
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
