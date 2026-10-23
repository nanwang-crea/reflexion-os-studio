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
import {
  assertComposerAlignment,
  assertComposerMetricBoundaries,
} from './composer-ui/alignment.mjs'
import { verifyComposerControls } from './composer-ui/controls.mjs'

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
        await assertComposerAlignment(page, `${theme} / ${width}px`)
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
    for (const theme of ['light', 'dark']) {
      await page.goto(`${url}?theme=${theme}`)
      await page.waitForSelector('.composer-send')
      await assertComposerMetricBoundaries(page)
    }
    await page.setViewportSize({ width: 940, height: 860 })
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
    await verifyComposerControls(page, url)
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
    // 窄宽度（对应用户截图场景）：提示文案必须单行；工具栏换行时
    // 模型/思考选择器必须同处一行并与发送按钮底对齐，不出现阶梯错位。
    await page.setViewportSize({ width: 460, height: 860 })
    await page.goto(`${url}?theme=light`)
    await page.waitForSelector('.composer-send')
    const narrow = await page.evaluate(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
      }
      return {
        placeholderWhiteSpace: getComputedStyle(
          document.querySelector('.composer textarea'),
          '::placeholder',
        ).whiteSpace,
        permission: rect('.composer-select.permission'),
        model: rect('.composer-select.model'),
        reasoning: rect('.composer-select.reasoning'),
        send: rect('.composer-send'),
      }
    })
    assert.equal(narrow.placeholderWhiteSpace, 'nowrap')
    assert.ok(
      narrow.reasoning.top - narrow.permission.top > 16,
      'toolbar wraps into two rows at this width',
    )
    assert.ok(
      narrow.model &&
        narrow.reasoning &&
        Math.abs(narrow.model.top - narrow.reasoning.top) <= 1,
      'model and reasoning selectors share one row',
    )
    assert.ok(
      Math.abs(narrow.send.bottom - narrow.reasoning.bottom) <= 2,
      'send button bottom-aligns with the model row',
    )
    assert.ok(
      narrow.send.left >= narrow.model.right,
      'send button stays right of the model cluster',
    )
    // 恢复后续 reasoning / dense-sidebar 断言所需的常规视口。
    await page.setViewportSize({ width: 940, height: 860 })
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
    // 隐藏操作不再挤压长标题；键盘聚焦后仍可访问原有操作。
    await page.goto(`${url}?theme=light&dense-sidebar=1`)
    await page.locator('.nested-list .session-main').waitFor()
    await page.mouse.move(900, 100)
    const label = page.locator('.nested-list .row-label')
    const idleWidth = (await label.boundingBox()).width
    assert.ok(idleWidth > 150)
    const title = '检查项目权限与聊天时间线的完整长标题'
    assert.equal(
      await page.locator('.session-main').getAttribute('title'),
      title,
    )
    assert.match(
      await page.locator('.project-select').getAttribute('title'),
      /ReflexionOS Studio 长项目名称/,
    )
    await page.locator('.session-main').focus()
    assert.ok((await label.boundingBox()).width < idleWidth)
    await page.keyboard.press('Tab')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '重命名会话',
    )
    await page.keyboard.press('Enter')
    await page.locator('.rename-input').waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.rename-input').count(), 0)
    if (process.env.UI_REVIEW_OUTPUT)
      await page.screenshot({
        path: join(process.env.UI_REVIEW_OUTPUT, 'sidebar-readable.png'),
      })

    // “＋”仅将可操作项暴露为菜单项，Escape 返回触发器。
    await page.goto(`${url}?theme=dark&busy-composer=1`)
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
    const plus = page.getByRole('button', { name: '添加功能', exact: true })
    await plus.focus()
    await page.keyboard.press('Enter')
    await page
      .getByRole('menuitem', { name: '添加文件', exact: true })
      .waitFor()
    assert.equal(await page.getByRole('menuitem').count(), 1)
    await page.getByText('快捷输入', { exact: true }).waitFor()
    const menu = await page.locator('.composer-plus-panel').boundingBox()
    assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= 940)
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '添加功能',
    )
    await page.getByRole('button', { name: '运行配置', exact: true }).click()
    await page.getByRole('dialog', { name: '运行配置', exact: true }).waitFor()
    await page
      .getByRole('checkbox', { name: '所有操作均询问', exact: false })
      .waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '运行配置',
    )
    await page.locator('.composer textarea').fill('稍后处理这个任务')
    await page.getByRole('button', { name: '加入队列', exact: true }).click()
    await page
      .getByLabel('已加入队列的消息', { exact: true })
      .getByText('稍后处理这个任务', { exact: true })
      .waitFor()
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
    for (const width of [600, 320]) {
      await page.setViewportSize({ width, height: 700 })
      await page.locator('.composer textarea').fill('继续排队')
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      )
      const permissionBox = await page
        .locator('.composer-select.permission')
        .boundingBox()
      const queueBox = await page
        .getByRole('button', { name: '加入队列', exact: true })
        .boundingBox()
      assert.ok(permissionBox.x + permissionBox.width <= queueBox.x)
      if (process.env.UI_REVIEW_OUTPUT && width === 320)
        await page.screenshot({
          path: join(process.env.UI_REVIEW_OUTPUT, 'composer-queue-narrow.png'),
        })
      await plus.click()
      const bounds = await page.locator('.composer-plus-panel').boundingBox()
      assert.ok(
        bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width,
      )
      await page.keyboard.press('Escape')
    }
    await page.getByRole('button', { name: '加入队列', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await page.getByRole('button', { name: '发送', exact: true }).waitFor()
    await page.goto(`${url}?theme=dark&busy-composer=1&hold-send=1`)
    await page.locator('.composer textarea').fill('发送中的消息')
    await page.getByRole('button', { name: '加入队列', exact: true }).click()
    await page.getByRole('button', { name: '运行配置', exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole('button', { name: '运行配置', exact: true })
        .isDisabled(),
      true,
    )
    assert.equal(
      await page
        .getByRole('button', { name: '添加功能', exact: true })
        .isDisabled(),
      true,
    )
    await page.getByRole('button', { name: '完成发送', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole('button', { name: '运行配置', exact: true })
        .isEnabled(),
      true,
    )
    await page.waitForTimeout(200)
    const commits = await page.locator('html').getAttribute('data-ui-commits')
    await page.waitForTimeout(400)
    assert.equal(
      await page.locator('html').getAttribute('data-ui-commits'),
      commits,
      'closed menus must not keep committing React updates',
    )
    await page.setViewportSize({ width: 940, height: 860 })
    await page.goto(`${url}?theme=dark`)
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
