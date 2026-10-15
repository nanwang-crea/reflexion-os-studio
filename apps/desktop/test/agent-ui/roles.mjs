import assert from 'node:assert/strict'

export async function verifyRoleEditor(page) {
  await page.getByRole('button', { name: '新建角色', exact: true }).click()
  const editor = page.locator('.agent-role-editor')
  await editor
    .getByRole('textbox', { name: '角色名称', exact: true })
    .fill('Feature reviewer')
  await editor
    .getByRole('textbox', { name: '职责与适用场景', exact: true })
    .fill('Independent review')
  await editor
    .getByRole('textbox', { name: '领域分类', exact: true })
    .fill('开发, 写作')
  const category = editor.getByRole('button', { name: '研究', exact: true })
  await category.click()
  assert.equal(await category.getAttribute('aria-pressed'), 'true')
  await category.click()
  await editor
    .getByRole('textbox', { name: '角色指令', exact: true })
    .fill('Review evidence and report actionable findings.')
  await editor.getByRole('combobox', { name: '执行模型', exact: true }).click()
  await page
    .getByRole('option', { name: 'Synthetic / review-model', exact: true })
    .click()
  await editor.getByRole('combobox', { name: '思考强度', exact: true }).click()
  await page.getByRole('option', { name: '高', exact: true }).click()

  await editor
    .getByRole('button', { name: '全选内置工具', exact: true })
    .click()
  assert.equal(
    await editor
      .getByRole('checkbox', { name: '删除文件', exact: true })
      .isChecked(),
    true,
  )
  assert.equal(
    await editor
      .getByRole('checkbox', { name: '执行命令', exact: true })
      .isChecked(),
    true,
  )
  await editor
    .getByRole('button', { name: '清空内置工具', exact: true })
    .click()
  assert.equal(
    await editor.locator('.role-tool-options input:checked').count(),
    0,
  )
  const readGroup = editor.getByRole('button', {
    name: '选择全部文件读取',
    exact: true,
  })
  await readGroup.focus()
  await page.keyboard.press('Enter')
  assert.equal(
    await editor.locator('.role-tool-options input:checked').count(),
    4,
  )
  await editor
    .getByRole('button', { name: '取消全部文件读取', exact: true })
    .click()
  assert.equal(
    await editor.locator('.role-tool-options input:checked').count(),
    0,
  )
  await editor.locator('.role-custom-tools summary').click()
  await editor
    .getByRole('textbox', { name: '添加工具标识', exact: true })
    .fill('research/search')
  await editor.getByRole('button', { name: '添加工具', exact: true }).click()
  await editor
    .getByRole('checkbox', { name: '允许继续委派给子 Agent', exact: true })
    .check()
  await editor.getByRole('button', { name: '文件编辑', exact: true }).click()
  assert.equal(
    await editor
      .getByRole('checkbox', { name: '执行命令', exact: true })
      .isChecked(),
    false,
  )
  assert.equal(
    await editor
      .getByRole('checkbox', { name: '删除文件', exact: true })
      .isChecked(),
    false,
  )
  assert.equal(
    await editor
      .getByRole('checkbox', { name: '分块写入', exact: true })
      .isChecked(),
    true,
  )
  assert.equal(
    await editor
      .getByRole('checkbox', { name: '允许继续委派给子 Agent', exact: true })
      .isChecked(),
    true,
  )
  await editor
    .getByRole('button', { name: '移除工具 research/search', exact: true })
    .waitFor()

  await editor
    .getByRole('heading', { name: '执行权限', exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/reflexion-role-permissions-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await editor
    .getByRole('heading', { name: '执行权限', exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({
    path: '/tmp/reflexion-role-permissions-mobile.png',
  })
  await page.setViewportSize({ width: 1200, height: 850 })
  await editor.getByRole('button', { name: '保存角色', exact: true }).click()
  await page.waitForFunction(() => window.roleSaves.length === 1)
  const saved = await page.evaluate(() => window.roleSaves[0])
  assert.deepEqual(saved.domains, ['开发', '写作'])
  assert.equal(saved.projectId, 'project')
  assert.deepEqual(saved.modelBinding, {
    mode: 'fixed',
    providerId: 'synthetic',
    model: 'review-model',
    reasoningEffort: 'high',
  })
  assert.equal(saved.permissionCeiling, 'workspace-read')
  assert.ok(saved.allowedTools.includes('research/search'))
  assert.ok(saved.allowedTools.includes('task'))
  assert.ok(saved.allowedTools.includes('file.write_stream'))
  assert.equal(saved.allowedTools.includes('shell.execute'), false)
  assert.equal(saved.canDelegate, true)
  await page.screenshot({ path: '/tmp/reflexion-agent-roles.png' })

  const scope = page
    .locator('.agent-role-filters')
    .getByRole('combobox', { name: '角色可用位置', exact: true })
  await scope.click()
  await page
    .getByRole('option', { name: 'Project B（含全局角色）', exact: true })
    .click()
  await page.getByRole('button', { name: '新建角色', exact: true }).click()
  assert.equal(
    await page
      .locator('.agent-role-editor')
      .getByRole('combobox', { name: '角色可用位置', exact: true })
      .textContent()
      .then((text) => text.includes('Project B')),
    true,
  )
  await page
    .locator('.agent-role-editor')
    .getByRole('button', { name: '取消', exact: true })
    .click()
}
