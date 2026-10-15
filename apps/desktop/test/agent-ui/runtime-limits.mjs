import assert from 'node:assert/strict'

export async function verifyRuntimeLimits(page) {
  await page.evaluate(() => window.showRuntimeLimits())
  const turns = page.getByRole('combobox', {
    name: '最大轮次（模型调用上限）模式',
    exact: true,
  })
  await turns.waitFor()
  assert.equal(await page.getByRole('combobox').count(), 8)
  await page
    .getByRole('button', { name: '将 8 项可选上限设为不限制', exact: true })
    .click()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.waitForFunction(() => window.runtimeSettingsSaves.length === 1)
  assert.equal(
    await page.evaluate(
      () => window.runtimeSettingsSaves[0].unlimitedLimits.length,
    ),
    8,
  )
  await page.evaluate(() => window.showRuntimeLimits())
  await turns.waitFor()
  assert.equal((await turns.textContent()).includes('不限制'), true)
  assert.equal(
    await page
      .getByRole('spinbutton', {
        name: '最大轮次（模型调用上限）',
        exact: true,
      })
      .count(),
    0,
  )
  await turns.click()
  await page.getByRole('option', { name: '自定义上限', exact: true }).click()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '输入自定义上限' }).waitFor()
  assert.equal(await page.evaluate(() => window.runtimeSettingsSaves.length), 1)
  await page
    .getByRole('spinbutton', { name: '最大轮次（模型调用上限）', exact: true })
    .fill('12')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.waitForFunction(() => window.runtimeSettingsSaves.length === 2)
  const saved = await page.evaluate(() => window.runtimeSettingsSaves[1])
  assert.equal(saved.maxTurns, 12)
  assert.equal(saved.unlimitedLimits.includes('maxTurns'), false)
  assert.equal(saved.unlimitedLimits.length, 7)
  await turns.click()
  await page.getByRole('option', { name: '使用默认值', exact: true }).click()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.waitForFunction(() => window.runtimeSettingsSaves.length === 3)
  assert.equal(
    await page.evaluate(() => window.runtimeSettingsSaves[2].maxTurns),
    null,
  )
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await page.screenshot({
    path: '/tmp/reflexion-runtime-unlimited-mobile.png',
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1200, height: 850 })
}
