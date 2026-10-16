import assert from 'node:assert/strict'

export async function verifyRolePackage(page) {
  await page.evaluate(() => {
    window.packageFixture = {
      digest: 'a'.repeat(64),
      role: {
        name: 'ZIP reviewer',
        description: 'Review reports',
        systemPrompt: 'Follow evidence.',
        permissionCeiling: 'workspace-read',
        allowedTools: ['skill.use'],
        canDelegate: false,
        skills: [{ skillId: 'report-helper', mode: 'startup' }],
      },
      skills: [{ id: 'report-helper', version: '1.0.0', action: 'install' }],
    }
  })
  await page
    .locator('input[type="file"][accept*=".reflexion-role.json"]')
    .setInputFiles({
      name: 'reviewer.reflexion-role.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('synthetic ZIP bytes'),
    })
  const dialog = page.getByRole('dialog', {
    name: '导入完整角色包',
    exact: true,
  })
  await dialog.waitFor()
  await dialog
    .getByText('report-helper v1.0.0 · 安装完整技能包 · 启动加载', {
      exact: true,
    })
    .waitFor()
  assert.equal(await page.evaluate(() => window.packageImported), undefined)
  await page.evaluate(() => {
    window.failPackageImport = true
  })
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  await dialog
    .getByRole('alert')
    .filter({ hasText: 'Synthetic package conflict' })
    .waitFor()
  assert.equal(await page.evaluate(() => window.packageImported), undefined)
  await page.evaluate(() => {
    window.failPackageImport = false
    window.pausePackageImport = true
  })
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  const importing = dialog.getByRole('button', {
    name: '正在导入…',
    exact: true,
  })
  await importing.waitFor()
  assert.equal(await importing.isDisabled(), true)
  await page.evaluate(() => {
    window.pausePackageImport = false
    window.releasePackageImport()
  })
  await dialog
    .getByRole('status')
    .filter({ hasText: '已导入角色“ZIP reviewer”，包含 1 个技能' })
    .waitFor()
  assert.equal(
    await dialog
      .getByRole('button', { name: '已导入', exact: true })
      .isDisabled(),
    true,
  )
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await page
    .locator('.role-import-feedback')
    .filter({ hasText: '已导入角色“ZIP reviewer”' })
    .waitFor()
  await page
    .locator('.agent-role-card')
    .filter({ hasText: 'ZIP reviewer' })
    .waitFor()
  const imported = await page.evaluate(() => window.packageImported)
  assert.equal(imported.projectId, 'other')
  assert.equal(imported.digest, 'a'.repeat(64))
  // A committed import must remain successful even if refreshing the catalog fails.
  await page
    .locator('input[type="file"][accept*=".reflexion-role.json"]')
    .setInputFiles({
      name: 'refresh.reflexion-role.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('synthetic ZIP bytes'),
    })
  await dialog.waitFor()
  await page.evaluate(() => {
    window.failRoleReload = true
  })
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  await dialog.getByRole('status').filter({ hasText: '列表刷新失败' }).waitFor()
  assert.equal(
    await dialog
      .getByRole('button', { name: '已导入', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(await dialog.getByRole('alert').count(), 0)
  assert.equal(await page.evaluate(() => window.packageAttempts), 3)
  await page.evaluate(() => {
    window.failRoleReload = false
  })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page
    .locator('.role-import-feedback')
    .filter({ hasText: '无需重复导入' })
    .waitFor()
}
