import assert from 'node:assert/strict'

export async function verifyRoleEditor(page) {
  assert.equal(await page.locator('.agent-role-side-panel').count(), 0)
  await page.getByRole('button', { name: '新建角色', exact: true }).click()
  const editor = page.locator('.agent-role-editor')
  const dock = await page.evaluate(() => {
    const pane = document
      .querySelector('.agent-role-side-panel')
      .getBoundingClientRect()
    const library = document
      .querySelector('.agent-roles-library')
      .getBoundingClientRect()
    const view = document
      .querySelector('.agent-roles-view')
      .getBoundingClientRect()
    return {
      right: pane.right,
      libraryRight: library.right,
      left: pane.left,
      viewRight: view.right,
      modal: document.querySelector('dialog:modal') !== null,
    }
  })
  assert.equal(dock.modal, false)
  assert.ok(Math.abs(dock.right - dock.viewRight) <= 1)
  assert.ok(dock.left >= dock.libraryRight - 1)
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
    .getByRole('combobox', { name: '添加角色技能', exact: true })
    .click()
  await page
    .getByRole('option', {
      name: 'Report helper · Report guidance',
      exact: true,
    })
    .click()
  await editor
    .getByRole('combobox', { name: 'project-skill 加载方式', exact: true })
    .click()
  await page.getByRole('option', { name: '启动加载', exact: true }).click()

  await editor
    .getByRole('heading', { name: '执行权限', exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/reflexion-role-permissions-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.locator('.agent-roles-library').isVisible(), false)
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
  assert.deepEqual(saved.skills, [
    { skillId: 'project-skill', mode: 'startup' },
  ])
  assert.ok(saved.allowedTools.includes('skill.use'))
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

  const search = page.getByRole('searchbox', { name: '搜索角色' })
  await search.fill('no matching role')
  assert.equal(await page.locator('.agent-role-card').count(), 0)
  await page.getByText('没有符合筛选条件的角色。', { exact: false }).waitFor()
  await page.getByRole('button', { name: '清空筛选', exact: true }).click()
  await search.fill('Feature reviewer')
  assert.equal(await page.locator('.agent-role-card').count(), 1)
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await editor
    .getByRole('textbox', { name: '角色名称', exact: true })
    .fill('Unsaved')
  await search.fill('')
  await page.evaluate(() => {
    window.blockRoleSwitch = true
  })
  await page
    .locator('.agent-role-card')
    .filter({ hasText: 'Review changes' })
    .getByRole('button', { name: '编辑', exact: true })
    .click()
  assert.equal(
    await editor
      .getByRole('textbox', { name: '角色名称', exact: true })
      .inputValue(),
    'Unsaved',
  )
  await page.evaluate(() => {
    window.blockRoleSwitch = false
  })
  await editor.getByRole('textbox', { name: '角色名称', exact: true }).focus()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(
    await editor
      .getByRole('textbox', { name: '角色名称', exact: true })
      .inputValue(),
    'Unsaved',
  )
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await page.getByRole('button', { name: '清空筛选', exact: true }).click()

  const filters = page.locator('.agent-role-filters')
  await filters.getByRole('combobox', { name: '角色来源', exact: true }).click()
  await page.getByRole('option', { name: '内置角色', exact: true }).click()
  assert.equal(await page.locator('.agent-role-card').count(), 0)
  await page.getByRole('button', { name: '清空筛选', exact: true }).click()
  await filters.getByRole('combobox', { name: '启用状态', exact: true }).click()
  await page.getByRole('option', { name: '已停用', exact: true }).click()
  assert.equal(await page.locator('.agent-role-card').count(), 0)
  await page.getByRole('button', { name: '清空筛选', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await page.screenshot({ path: '/tmp/reflexion-agent-roles-mobile.png' })
  await page.setViewportSize({ width: 1200, height: 850 })

  const scope = page
    .locator('.agent-role-filters')
    .getByRole('combobox', { name: '查看范围', exact: true })
  await scope.click()
  await page
    .getByRole('option', { name: 'Project B（含通用角色）', exact: true })
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
