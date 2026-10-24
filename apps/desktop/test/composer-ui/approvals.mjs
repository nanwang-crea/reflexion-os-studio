import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function verifyPendingApprovals(page, url) {
  const viewport = page.viewportSize()
  await verifyArrivingRequests(page, url)
  await page.setViewportSize({ width: 1440, height: 900 })
  const base = '?chat&approval&no-terminal&empty-queue'
  for (const scenario of ['', '&stale-run', '&legacy-approval']) {
    await page.goto(url + base + scenario)
    const card = page.getByRole('alertdialog')
    await page.locator('.composer').waitFor()
    assert.equal(await card.count(), 1, `approval is rendered: ${scenario}`)
    const layout = await page
      .locator('.chat-composer-context')
      .evaluate((el) => {
        const card = el.querySelector('.approval-card').getBoundingClientRect()
        const context = el.getBoundingClientRect()
        return { cardHeight: card.height, contextHeight: context.height }
      })
    assert.ok(
      layout.contextHeight >= layout.cardHeight,
      'a lone approval card is visible above the composer',
    )
    if (scenario === '&stale-run') {
      if (process.env.UI_REVIEW_OUTPUT)
        await page.screenshot({
          path: join(
            process.env.UI_REVIEW_OUTPUT,
            'approval-before-snapshot.png',
          ),
        })
      await page.locator('#load-snapshot').evaluate((button) => button.click())
      assert.equal(await card.count(), 1)
    }
    await card.getByRole('button', { name: '允许一次', exact: true }).click()
    assert.equal(await page.locator('#resolved').textContent(), 'allow-once')
  }
  await page.goto(url + base + '&stale-run&other-session')
  await page.locator('.composer').waitFor()
  assert.equal(await page.getByRole('alertdialog').count(), 0)
  await page.goto(url + '?chat&interaction&stale-run&no-terminal&empty-queue')
  await page.getByRole('radio').last().check()
  await page.getByRole('button', { name: '提交回答', exact: true }).click()
  assert.equal(await page.locator('#resolved').textContent(), 'answer')
  await page.goto(
    url + '?chat&interaction&stale-run&no-terminal&empty-queue&other-session',
  )
  await page.locator('.composer').waitFor()
  assert.equal(await page.getByRole('radio').count(), 0)
  await page.setViewportSize(viewport)
}

async function verifyArrivingRequests(page, url) {
  for (const kind of ['approval', 'interaction', 'plan']) {
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.goto(url + `?chat&${kind}&delayed&no-terminal&empty-queue`)
    await page.locator('.composer').waitFor()
    await page
      .getByRole('button', { name: '对话工具菜单', exact: true })
      .click()
    await page
      .getByRole('menuitemcheckbox', { name: '网页浏览', exact: true })
      .click()
    await page.locator('.composer textarea').fill('审批到达前正在输入的草稿')
    for (let arrival = 0; arrival < 2; arrival++) {
      await page.locator('#show-pending').evaluate((el) => el.click())
      const action =
        kind === 'plan'
          ? page.locator('.plan-float-head')
          : page.getByRole('button', {
              name: kind === 'approval' ? '允许一次' : '提交回答',
              exact: true,
            })
      await action.waitFor({ state: 'attached' })
      const layout = await page
        .locator('.chat-composer-context')
        .evaluate((el) => {
          const rect = el.getBoundingClientRect()
          return { height: rect.height, top: rect.top, bottom: rect.bottom }
        })
      assert.ok(
        layout.height >= 40,
        `${kind} must expand on arrival: ${JSON.stringify(layout)}`,
      )
      if (kind !== 'interaction') {
        assert.equal(
          await action.evaluate((el) => {
            const r = el.getBoundingClientRect()
            return el.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            )
          }),
          true,
          'approval actions are visible without clicking or scrolling them into view',
        )
      }
      assert.equal(
        await page.locator('.composer textarea').inputValue(),
        '审批到达前正在输入的草稿',
      )
      if (process.env.UI_REVIEW_OUTPUT)
        await page.screenshot({
          path: join(
            process.env.UI_REVIEW_OUTPUT,
            `arriving-${kind}-${arrival}.png`,
          ),
        })
      await page.locator('#hide-pending').evaluate((el) => el.click())
      assert.equal(await action.count(), 0)
    }
  }
}
