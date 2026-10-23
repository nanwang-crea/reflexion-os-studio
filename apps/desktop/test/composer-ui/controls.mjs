import assert from 'node:assert/strict'

export async function verifyComposerControls(page, url) {
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 940, height: 860 })
    await page.goto(`${url}?theme=${theme}&reasoning=supported`)
    const project = page.getByRole('combobox', { name: '新会话项目' })
    // The icon belongs to the trigger, so clicking it opens the same menu.
    await project.locator('svg').first().click()
    await page.getByRole('option', { name: '独立对话', exact: true }).waitFor()
    await page.getByRole('option', { name: '独立对话', exact: true }).focus()
    await page.keyboard.press('End')
    await page.waitForFunction(() =>
      document.activeElement?.textContent?.includes('ReflexionOS Studio'),
    )
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '新会话项目',
    )
    assert.match(await project.innerText(), /ReflexionOS Studio 长项目名称/)
    const layout = await page.evaluate(() => {
      const header = document
        .querySelector('.landing-composer-header')
        .getBoundingClientRect()
      const project = document
        .querySelector('[aria-label="新会话项目"]')
        .getBoundingClientRect()
      const composer = document
        .querySelector('.composer')
        .getBoundingClientRect()
      return {
        gap: composer.top - header.bottom,
        inset: header.left - composer.left,
        projectBottom: project.bottom,
        composerTop: composer.top,
      }
    })
    assert.ok(layout.gap <= 0 && layout.gap >= -12, 'header joins the input')
    assert.ok(layout.inset > 0, 'header is inset above the rounded input')
    assert.ok(
      layout.projectBottom <= layout.composerTop,
      'the input does not cover the project selector',
    )
    await project.click()
    await page.getByRole('option', { name: '独立对话', exact: true }).click()

    const permission = page.getByRole('combobox', { name: '权限档位' })
    await permission.locator('svg').first().click()
    await page.getByRole('option').first().waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '权限档位',
    )
    // Exercise enlarged text in a split without clipping the controls.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '17px'
    })
    for (const control of [project, permission]) {
      const box = await control.boundingBox()
      assert.ok(box.height >= 32)
      assert.ok(box.x >= 0 && box.x + box.width <= 940)
    }
    await project.click()
    const menu = await page.locator('.ui-select-menu').boundingBox()
    assert.ok(menu.x >= 0 && menu.x + menu.width <= 940)
    assert.ok(menu.y >= 0 && menu.y + menu.height <= 860)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '打开设置', exact: true }).click()
    await page.locator('.settings-view').waitFor()
  }
}
