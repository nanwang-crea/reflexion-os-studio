import assert from 'node:assert/strict'

export async function assertComposerAlignment(page, scenario) {
  const boxes = await page.evaluate(() => {
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    }
    return {
      composer: box('.composer'),
      send: box('.composer-send'),
      controls: box('.composer-controls'),
      model: box('.composer-model-cluster'),
      selectors: [
        box('.composer-select.model'),
        box('.composer-select.reasoning'),
      ],
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
  const detail = `${scenario}: ${JSON.stringify(boxes)}`
  assert.equal(boxes.overflow, false, detail)
  assert.ok(boxes.send.right <= boxes.composer.right, detail)
  assert.ok(boxes.send.right >= boxes.composer.right - 18, detail)
  assert.ok(boxes.controls.right <= boxes.send.left, detail)
  assert.ok(Math.abs(boxes.send.bottom - boxes.model.bottom) <= 2, detail)
  for (const selector of boxes.selectors) {
    assert.ok(selector.left >= boxes.controls.left, detail)
    assert.ok(selector.right <= boxes.controls.right + 1, detail)
  }
}

export async function assertComposerMetricBoundaries(page) {
  // A one-pixel font-metric change can move the model cluster onto the first
  // line while leaving the send button on a line of its own (Windows CI).
  for (const width of [940, 920, 900]) {
    await page.setViewportSize({ width, height: 860 })
    for (const permissionWidth of [96, 100, 104]) {
      await page
        .locator('.composer-select.permission')
        .evaluate((el, value) => {
          el.style.width = `${value}px`
        }, permissionWidth)
      await assertComposerAlignment(
        page,
        `${width}px / permission ${permissionWidth}px`,
      )
    }
  }
  await page.locator('.composer-select.permission').evaluate((el) => {
    el.style.removeProperty('width')
  })
}
