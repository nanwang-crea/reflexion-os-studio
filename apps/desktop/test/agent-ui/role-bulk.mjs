import assert from 'node:assert/strict'

export async function verifyRoleBulk(page) {
  await page.evaluate(() => {
    const roles = Array.from({ length: 23 }, (_, index) => ({
      id: `bulk-${index}`,
      name: `Role ${index}`,
      description: 'Batch management fixture',
      systemPrompt: `Keep instruction ${index}`,
      updatedAt: '2026-10-15T00:00:00Z',
      domains: ['写作组'],
      projectId: null,
      modelBinding: { mode: 'inherit' },
      source: 'user',
      builtin: false,
      enabled: index % 2 === 0,
      policy: {
        permissionCeiling: 'workspace-read',
        allowedTools: index % 2 ? ['file.list'] : ['file.read'],
        canDelegate: false,
      },
    }))
    window.setRoleTemplates([
      {
        ...roles[0],
        id: 'builtin',
        name: 'Builtin',
        builtin: true,
        source: 'builtin',
      },
      ...roles,
    ])
    window.showRoles()
  })
  await page.locator('.agent-role-card').nth(9).waitFor()
  assert.equal(await page.locator('.agent-role-card').count(), 10)
  assert.equal(
    await page
      .getByRole('checkbox', { name: '选择 Builtin', exact: true })
      .isDisabled(),
    true,
  )
  await page
    .getByRole('checkbox', { name: '选择本页自定义角色', exact: true })
    .check()
  await page.getByText('已选 9 个', { exact: true }).waitFor()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  assert.equal(await page.locator('.agent-role-card').count(), 10)
  await page
    .getByRole('checkbox', { name: '选择本页自定义角色', exact: true })
    .check()
  await page.getByText('已选 19 个', { exact: true }).waitFor()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  assert.equal(await page.locator('.agent-role-card').count(), 4)
  await page.getByRole('searchbox', { name: '搜索角色' }).fill('Role 22')
  assert.equal(await page.locator('.agent-role-card').count(), 1)
  assert.equal(
    await page.getByRole('navigation', { name: '角色分页' }).count(),
    0,
  )
  await page.getByRole('searchbox', { name: '搜索角色' }).fill('')
  await page.getByText('已选 0 个', { exact: true }).waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: '上一页', exact: true })
      .isDisabled(),
    true,
  )
  await page.getByRole('combobox', { name: '领域分类', exact: true }).click()
  await page.getByRole('option', { name: '写作组', exact: true }).click()
  await page
    .getByRole('button', { name: '选择筛选结果（23）', exact: true })
    .click()
  await page.getByText('已选 23 个', { exact: true }).waitFor()
  await page.screenshot({
    path: '/tmp/reflexion-roles-grid-selection.png',
    animations: 'disabled',
  })
  await page.getByRole('button', { name: '批量修改', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量修改角色', exact: true })
  assert.equal(await dialog.getAttribute('aria-modal'), 'false')
  await page.getByRole('searchbox', { name: '搜索角色' }).fill('Role 22')
  await dialog
    .getByRole('heading', { name: '批量修改 23 个角色', exact: true })
    .waitFor()
  assert.equal(await page.locator('.agent-role-card').count(), 1)
  await page.getByRole('searchbox', { name: '搜索角色' }).fill('')
  await page.screenshot({
    path: '/tmp/reflexion-roles-side-panel.png',
    animations: 'disabled',
  })
  const apply = dialog.getByRole('button', {
    name: '应用到 23 个角色',
    exact: true,
  })
  assert.equal(await apply.isDisabled(), true)
  await dialog
    .getByRole('checkbox', { name: '修改所属项目 / 工作区', exact: true })
    .check()
  await dialog
    .getByRole('combobox', { name: '统一可用位置', exact: true })
    .click()
  await page
    .getByRole('option', { name: '仅项目 · Project B', exact: true })
    .click()
  await dialog
    .getByRole('checkbox', { name: '修改审批档位上限', exact: true })
    .check()
  await page.evaluate(() => {
    window.failBulk = true
  })
  await apply.click()
  await dialog
    .getByRole('alert')
    .getByText('Synthetic bulk failure', { exact: true })
    .waitFor()
  assert.equal(await page.evaluate(() => window.roleBulkSaves.length), 0)
  await page.evaluate(() => {
    window.failBulk = false
  })
  await apply.click()
  await dialog.waitFor({ state: 'hidden' })
  const saved = await page.evaluate(() => window.roleBulkSaves[0])
  assert.equal(saved.targets.length, 23)
  assert.deepEqual(saved.patch, {
    projectId: 'other',
    permissionCeiling: 'workspace-read',
  })
  assert.equal(await page.locator('.agent-role-card').count(), 1)
  await page
    .getByRole('combobox', { name: '角色可用位置', exact: true })
    .click()
  await page
    .getByRole('option', { name: 'Project B（含全局角色）', exact: true })
    .click()
  await page
    .getByRole('button', { name: '选择筛选结果（23）', exact: true })
    .click()
  await page.getByRole('button', { name: '批量修改', exact: true }).click()
  await dialog
    .getByRole('checkbox', { name: '统一工具能力与委派设置', exact: true })
    .check()
  await dialog.getByRole('button', { name: '文件编辑', exact: true }).click()
  await dialog
    .getByRole('checkbox', { name: '统一允许继续委派', exact: true })
    .check()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await page.screenshot({
    path: '/tmp/reflexion-roles-bulk-mobile.png',
    animations: 'disabled',
  })
  await apply.click()
  await dialog.waitFor({ state: 'hidden' })
  const toolPatch = await page.evaluate(() => window.roleBulkSaves[1].patch)
  assert.equal(toolPatch.canDelegate, true)
  assert.ok(toolPatch.allowedTools.includes('file.write_stream'))
  assert.equal('projectId' in toolPatch, false)
  assert.equal('permissionCeiling' in toolPatch, false)
  await page.setViewportSize({ width: 1200, height: 850 })
}
