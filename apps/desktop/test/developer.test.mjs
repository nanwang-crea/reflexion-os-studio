import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDeveloperPage } from './fixtures/developer-harness.mjs'

test('developer page filters, pages, drills into child Runs/tools, cleans subscriptions and fits narrow windows', async () => {
  const { browser, page, errors } = await openDeveloperPage()
  try {
    await page.getByRole('button', { name: '开发者', exact: true }).click()
    await page.getByRole('heading', { name: '开发者', exact: true }).waitFor()
    await page.getByText('输入 tokens', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.listeners.size), 1)
    await page.screenshot({ path: '/tmp/reflexion-developer-wide.png' })

    await page.getByLabel('开始日期', { exact: true }).fill('2026-10-22')
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-22')
    await page.getByRole('button', { name: '应用筛选', exact: true }).click()
    await page.waitForFunction(() =>
      window.calls.some(
        (call) => call.method === 'overview' && call.params.from,
      ),
    )
    const filter = await page.evaluate(
      () =>
        window.calls.filter((call) => call.method === 'overview').at(-1).params,
    )
    assert.equal(filter.from, '2026-10-21T16:00:00.000Z')
    assert.equal(filter.to, '2026-10-22T16:00:00.000Z')
    assert.equal(await page.evaluate(() => window.listeners.size), 1)

    // Select has a label, keyboard navigation and Escape focus restoration.
    await page.getByRole('combobox', { name: '筛选项目' }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('option', { name: '独立会话', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '筛选项目',
    )
    assert.equal(
      await page
        .getByRole('combobox', { name: '筛选项目' })
        .evaluate((element) => element === document.activeElement),
      true,
    )

    await page.getByRole('button', { name: '运行记录', exact: true }).click()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.waitForFunction(() =>
      window.calls.some(
        (call) => call.method === 'runs' && call.params.offset === 25,
      ),
    )
    await page.getByRole('button', { name: '上一页', exact: true }).click()
    await page
      .getByRole('button', { name: '开发者测试对话', exact: true })
      .click()
    await page.getByRole('heading', { name: '运行详情', exact: true }).waitFor()
    await page.getByRole('button', { name: '子 Run（1）', exact: true }).click()
    await page.getByRole('button', { name: '子任务示例', exact: true }).click()
    await page
      .getByRole('button', { name: '查看父 Run：root', exact: true })
      .click()
    await page
      .getByRole('button', { name: '返回所属对话', exact: true })
      .click()
    assert.deepEqual(await page.evaluate(() => window.opened), [
      { sessionId: 'session', projectId: 'project' },
    ])
    await page
      .getByRole('button', { name: '工具调用', exact: true })
      .last()
      .click()
    await page.getByRole('button', { name: 'file.read', exact: true }).click()
    await page
      .getByRole('heading', { name: '工具调用详情', exact: true })
      .waitFor()
    assert.match(
      await page.locator('.developer-facts:visible').innerText(),
      /300 ms/,
    )
    assert.match(
      await page.locator('.developer-facts:visible').innerText(),
      /20 ms/,
    )
    await page.getByText('工具结果', { exact: true }).click()
    await page.getByText('完整工具结果', { exact: true }).waitFor()

    await page.setViewportSize({ width: 420, height: 850 })
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    )
    await page.screenshot({ path: '/tmp/reflexion-developer-narrow.png' })
    await page.getByRole('button', { name: '用量概览', exact: true }).click()
    await page.getByText('输入 tokens', { exact: true }).waitFor()
    const before = await page.evaluate(() => window.calls.length)
    await page.evaluate(() => {
      for (let i = 0; i < 200; i++)
        for (const handler of window.listeners)
          handler({ type: 'message.delta' })
    })
    await page.waitForTimeout(400)
    assert.equal(await page.evaluate(() => window.calls.length), before)
    await page.evaluate(() => {
      window.failOverview = true
    })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '测试加载错误' }).waitFor()
    await page.evaluate(() => {
      window.failOverview = false
    })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByText('输入 tokens', { exact: true }).waitFor()
    await page.evaluate(() => window.unmount())
    assert.equal(await page.evaluate(() => window.listeners.size), 0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('refreshes serialize slow queries and ignore old filter responses', async () => {
  const { browser, page, errors } = await openDeveloperPage()
  try {
    await page.getByRole('button', { name: '开发者', exact: true }).click()
    await page.getByText('输入 tokens', { exact: true }).waitFor()
    await page.evaluate(() => {
      window.delayOverview = true
    })
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(() => window.overviewResolvers?.length === 1)
    const before = await page.evaluate(
      () => window.calls.filter((call) => call.method === 'overview').length,
    )
    await page.evaluate(() => {
      for (const handler of window.listeners)
        handler({ type: 'developer.updated' })
    })
    await page.waitForTimeout(400)
    assert.equal(
      await page.evaluate(
        () => window.calls.filter((call) => call.method === 'overview').length,
      ),
      before,
    )
    await page.evaluate(() => window.overviewResolvers.shift()())
    await page.waitForFunction(
      (count) =>
        window.calls.filter((call) => call.method === 'overview').length ===
        count + 1,
      before,
    )
    await page.getByText('输入 tokens', { exact: true }).waitFor()
    await page.evaluate(() => window.overviewResolvers.shift()())

    // An old in-flight request must not overwrite a new filter's result.
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.waitForFunction(() => window.overviewResolvers.length === 1)
    await page.getByLabel('筛选模型', { exact: true }).fill('new-filter')
    await page.getByRole('button', { name: '应用筛选', exact: true }).click()
    await page.waitForFunction(() => window.overviewResolvers.length === 2)
    await page.evaluate(() => window.overviewResolvers.pop()())
    await page
      .locator('.developer-card strong')
      .first()
      .getByText('999', { exact: true })
      .waitFor()
    await page.evaluate(() => window.overviewResolvers.shift()())
    await page.waitForTimeout(50)
    assert.equal(
      await page.locator('.developer-card strong').first().innerText(),
      '999',
    )
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test('returning from Run and tool details preserves pagination and local filters', async () => {
  const { browser, page, errors } = await openDeveloperPage()
  try {
    await page.getByRole('button', { name: '开发者', exact: true }).click()
    await page.getByRole('button', { name: '运行记录', exact: true }).click()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.waitForFunction(() =>
      window.calls.some(
        (call) => call.method === 'runs' && call.params.offset === 25,
      ),
    )
    await page
      .getByRole('button', { name: '开发者测试对话', exact: true })
      .click()
    await page
      .getByRole('button', { name: '返回所属对话', exact: true })
      .waitFor()
    await page.getByRole('button', { name: '← 返回列表', exact: true }).click()
    assert.match(
      await page.locator('[aria-label="分页"]:visible').innerText(),
      /26–26/,
    )
    await page
      .getByRole('button', { name: '开发者测试对话', exact: true })
      .click()
    await page
      .getByRole('button', { name: '工具调用', exact: true })
      .last()
      .click()
    await page.getByLabel('工具名称', { exact: true }).fill('file.read')
    await page.getByRole('button', { name: 'file.read', exact: true }).click()
    await page
      .getByRole('heading', { name: '工具调用详情', exact: true })
      .waitFor()
    const hiddenQueries = await page.evaluate(
      () =>
        window.calls.filter((call) =>
          ['runs', 'run', 'tools', 'models'].includes(call.method),
        ).length,
    )
    await page.evaluate(() => {
      for (const handler of window.listeners)
        handler({ type: 'developer.updated' })
    })
    await page.waitForTimeout(400)
    assert.equal(
      await page.evaluate(
        () =>
          window.calls.filter((call) =>
            ['runs', 'run', 'tools', 'models'].includes(call.method),
          ).length,
      ),
      hiddenQueries,
    )
    await page.getByRole('button', { name: '← 返回', exact: true }).click()
    await page.getByLabel('工具名称', { exact: true }).waitFor()
    assert.equal(
      await page.getByLabel('工具名称', { exact: true }).inputValue(),
      'file.read',
    )
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
