import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function verifyPendingApprovals(page, url) {
  const viewport = page.viewportSize()
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
