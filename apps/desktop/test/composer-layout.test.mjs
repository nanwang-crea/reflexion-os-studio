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
            build.onLoad({ filter: /api[\\/]queue\.ts$/ }, () => ({
              contents: `
                let items = Array.from({length: 20}, (_, i) => ({id: 'queue-'+i, content: '排队消息 '+i, permissionPreset: 'workspace-write', agentTemplateId: 'long-template-name-that-must-wrap'}));
                const listeners = new Set();
                const notify = () => {for(const fn of listeners) fn('s', items, true)};
                export const listQueue = async () => ({items, paused: true});
                export const onQueueChanged = fn => {listeners.add(fn); return () => listeners.delete(fn)};
                export const removeQueue = async (_, id) => {items = items.filter(x=>x.id !== id); notify()};
                export const updateQueue = async (_, id, content) => {items = items.map(x=>x.id === id ? {...x, content} : x); notify(); return {item: items.find(x=>x.id === id)}};
                export const resumeQueue = async () => {};
                export const sendNow = async () => {};
              `,
              loader: 'ts',
            }))
            build.onLoad(
              {
                filter:
                  /(?:FileViewerPanel|BrowserSurfacePanel|InstructionsView|SkillsView|AgentRolesView|CollaborationPanel)\.tsx$/,
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
    for (const mode of [
      '',
      '?standalone',
      '?chat',
      '?no-provider',
      '?chat&crowded',
      '?chat&crowded&danger',
      '?files',
    ]) {
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
      if (mode === '?files') {
        await page.locator('input[type=file]').setInputFiles(
          Array.from({ length: 4 }, (_, i) => ({
            name: `example-${i}.txt`,
            mimeType: 'text/plain',
            buffer: Buffer.from('附件内容'),
          })),
        )
        await page.locator('.composer-image').nth(3).waitFor()
      }
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
      if (mode.includes('crowded')) {
        await page
          .getByRole('button', { name: '修改', exact: true })
          .first()
          .click()
        await page.locator('.queue-edit').fill('调整后的排队消息')
        await page.getByRole('button', { name: '保存', exact: true }).click()
        await page
          .getByRole('button', { name: '允许一次', exact: true })
          .click()
        assert.equal(
          await page.locator('#resolved').textContent(),
          'allow-once',
        )
        await page.getByRole('radio').last().check()
        await page
          .getByRole('button', { name: '提交回答', exact: true })
          .click()
        assert.equal(await page.locator('#resolved').textContent(), 'answer')
        await assertComposerAccessible(page)
      }
      if (mode.includes('danger')) {
        const disable = page.getByRole('button', {
          name: '立即关闭',
          exact: true,
        })
        assert.equal(
          await disable.evaluate((el) => {
            const r = el.getBoundingClientRect()
            return el.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            )
          }),
          true,
        )
        await disable.click()
        await assertComposerAccessible(page)
      }
      if (mode === '?files') {
        await page
          .getByRole('button', { name: '移除 example-3.txt', exact: true })
          .click()
        assert.equal(await page.locator('.composer-image').count(), 3)
        await assertComposerAccessible(page)
      }
      if (mode !== '?no-provider') {
        await page.locator('.composer textarea').fill('布局调整后继续发送')
        await assertComposerAccessible(page)
        await page
          .getByRole('button', {
            name: mode.includes('crowded') ? '加入队列' : '发送',
            exact: true,
          })
          .click()
        await page.waitForFunction(
          () =>
            document.getElementById('sent').textContent ===
            '布局调整后继续发送',
        )
      }
    }
    await page.goto(url + '?settings')
    await page
      .getByRole('button', { name: '对话工具菜单', exact: true })
      .click()
    await page
      .getByRole('menuitemcheckbox', { name: '网页浏览', exact: true })
      .click()
    await page.getByRole('button', { name: '外观', exact: true }).click()
    const settings = await page.evaluate(() => {
      const nav = document
        .querySelector('.settings-nav')
        .getBoundingClientRect()
      const content = document.querySelector('.settings-content')
      return {
        navBottom: nav.bottom,
        contentTop: content.getBoundingClientRect().top,
        width: content.clientWidth,
        overflow: content.scrollWidth > content.clientWidth,
      }
    })
    assert.ok(
      settings.contentTop >= settings.navBottom,
      JSON.stringify(settings),
    )
    assert.ok(settings.width >= 300, JSON.stringify(settings))
    assert.equal(settings.overflow, false)
    await page.goto(url + '?floating')
    await page.getByTitle('分支：切换 / 新建').click()
    const branch = page.getByRole('button', { name: 'feature/test' })
    await branch.waitFor()
    assert.equal(
      await branch.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return el.contains(
          document.elementFromPoint(r.right - 4, r.y + r.height / 2),
        )
      }),
      true,
      'branch popup must not be clipped by the sidebar',
    )
    await branch.click()
    assert.equal(
      await page.locator('#floating-result').innerText(),
      'feature/test',
    )
    await page.getByTitle('分支：切换 / 新建').click()
    await page.getByPlaceholder('新分支名称').fill('new-layout-branch')
    await page.keyboard.press('Enter')
    assert.equal(
      await page.locator('#floating-result').innerText(),
      'new-layout-branch',
    )
    await page.getByTitle('分支：切换 / 新建').click()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('title') === '分支：切换 / 新建',
    )
    await page.getByRole('button', { name: '更多操作', exact: true }).click()
    const history = page.getByRole('menuitem', {
      name: '基于此建分支…',
      exact: true,
    })
    await history.waitFor()
    const menu = await page.locator('.git-hist-menu').boundingBox()
    assert.ok(
      menu.y >= 0 &&
        menu.x >= 0 &&
        menu.y + menu.height <= 600 &&
        menu.x + menu.width <= 940,
    )
    await history.focus()
    await page.keyboard.press('Enter')
    assert.equal(
      await page.locator('#floating-result').innerText(),
      'branch-form',
    )
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('placeholder') === '新分支名称',
    )
    await page.getByRole('button', { name: '运行配置', exact: true }).click()
    const config = page.getByRole('dialog', { name: '运行配置', exact: true })
    await config.waitFor()
    const configBox = await config.boundingBox()
    assert.ok(
      configBox.height > 120 &&
        configBox.y >= 0 &&
        configBox.y + configBox.height <= 600,
    )
    await page.locator('.sidebar').evaluate((el) => {
      el.style.width = '360px'
    })
    await page.waitForFunction(
      () =>
        Math.abs(
          document
            .querySelector('.composer-run-config-panel')
            .getBoundingClientRect().left -
            document
              .querySelector('.composer-run-config-trigger')
              .getBoundingClientRect().left,
        ) < 2,
    )
    await page
      .getByRole('combobox', { name: '默认子 Agent 模板', exact: true })
      .click()
    await page
      .getByRole('option', { name: '布局验收模板', exact: true })
      .click()
    assert.equal(await page.locator('#floating-result').innerText(), 'template')
    assert.equal(await config.isVisible(), true)
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '运行配置',
    )
    await page.getByRole('button', { name: '打开确认框', exact: true }).click()
    await page.locator('.confirm-dialog-modal[open]').waitFor()
    assert.equal(
      await page
        .locator('.dialog')
        .evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
    )
    await page.getByRole('button', { name: '取消', exact: true }).click()
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
