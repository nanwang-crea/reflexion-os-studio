import assert from 'node:assert/strict'

/** Check actual card bounds rather than CSS implementation details. */
export async function verifyDelegationLayout(page) {
  await page.evaluate(() => window.showDelegations())
  for (const width of [1100, 600, 320]) {
    await page.setViewportSize({ width, height: 800 })
    await page.locator('.delegation-row').first().waitFor()
    const layout = await page.locator('.delegation-row').evaluateAll((rows) =>
      rows.map((row) => {
        const button = row
          .querySelector('.delegation-open')
          .getBoundingClientRect()
        const name = row.querySelector('.trace-name').getBoundingClientRect()
        const summary = row
          .querySelector('.trace-summary')
          .getBoundingClientRect()
        const status = row
          .querySelector('.trace-status')
          .getBoundingClientRect()
        const error = row
          .querySelector('.delegation-error')
          ?.getBoundingClientRect()
        const bounds = row.getBoundingClientRect()
        return {
          headerSeparated:
            name.right <= summary.left && summary.right <= status.left,
          nameHeight: name.height,
          statusHeight: status.height,
          separated: !error || error.top >= button.bottom,
          contained: !error || error.right <= bounds.right,
          overflow: row.scrollWidth > row.clientWidth,
        }
      }),
    )
    for (const row of layout) {
      assert.ok(row.headerSeparated, 'name, task and status must not overlap')
      assert.ok(row.nameHeight < 35, 'role name must remain on one line')
      assert.ok(row.statusHeight < 30, 'status must remain on one line')
      assert.ok(row.separated, 'errors must be below the clickable header')
      assert.ok(row.contained, 'long errors must wrap inside the card')
      assert.equal(row.overflow, false)
    }
  }
  await page.screenshot({ path: '/tmp/reflexion-delegation-layout.png' })
  await page.setViewportSize({ width: 600, height: 450 })
}
