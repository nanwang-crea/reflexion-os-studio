import assert from 'node:assert/strict'

export async function verifyRoleSharing(page) {
  const before = await page.evaluate(() => window.roleSaves.length)
  const input = page.locator(
    'input[type="file"][accept*=".reflexion-role.json"]',
  )
  const share = {
    format: 'reflexion-role',
    version: 1,
    role: {
      name: 'Shared reviewer',
      description: 'Portable guidance',
      systemPrompt: 'Review evidence carefully.',
      domains: ['开发'],
      permissionCeiling: 'workspace-read',
      allowedTools: ['file.read'],
      canDelegate: false,
    },
  }
  await input.setInputFiles({
    name: 'shared.reflexion-role.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...share, version: 99 })),
  })
  await page
    .getByRole('alert')
    .filter({ hasText: '角色文件格式或版本不支持' })
    .waitFor()
  assert.equal(await page.locator('.agent-role-editor').count(), 0)
  await input.setInputFiles({
    name: 'shared.reflexion-role.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(share)),
  })
  await page
    .getByRole('status')
    .filter({ hasText: '已读取到编辑器，尚未保存' })
    .waitFor()
  const editor = page.locator('.agent-role-editor')
  await editor.waitFor()
  assert.equal(
    await editor
      .getByRole('textbox', { name: '角色名称', exact: true })
      .inputValue(),
    share.role.name,
  )
  assert.equal(
    await editor
      .getByRole('checkbox', { name: '启用角色', exact: true })
      .isChecked(),
    false,
  )
  assert.equal(await page.evaluate(() => window.roleSaves.length), before)
  await editor.getByRole('button', { name: '保存角色', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
  await page
    .getByRole('status')
    .filter({ hasText: '已保存“Shared reviewer”' })
    .waitFor()
  assert.equal(await page.locator('.role-import-feedback').count(), 0)
  const saved = await page.evaluate(() => window.roleSaves.at(-1))
  assert.equal(saved.id, undefined)
  assert.equal(saved.enabled, false)
  assert.deepEqual(saved.modelBinding, { mode: 'inherit' })
  assert.equal(saved.systemPrompt, share.role.systemPrompt)
}

export async function verifyTeamSharing(page) {
  await page.evaluate(() => window.clearUI())
  await page.locator('.agent-roles-view').waitFor({ state: 'detached' })
  await page.evaluate(() => {
    const roles = Array.from({ length: 13 }, (_, i) => ({
      id: `team-role-${i}`,
      name: `Team role ${i}`,
      description: 'Team member',
      systemPrompt: 'Follow evidence.',
      domains: ['team:writing'],
      projectId: 'project',
      modelBinding: { mode: 'inherit' },
      builtin: false,
      enabled: i % 2 === 0,
      policy: {
        permissionCeiling: 'workspace-read',
        allowedTools: ['file.read'],
        canDelegate: false,
      },
    }))
    window.setRoleTemplates([
      ...roles,
      {
        ...roles[0],
        id: 'global-role',
        name: 'Global writer',
        projectId: null,
      },
    ])
    window.showRoles()
  })
  await page.getByRole('button', { name: '导出团队', exact: true }).waitFor()
  await page
    .getByRole('searchbox', { name: '搜索角色', exact: true })
    .fill('Team role 0')
  await page.getByRole('button', { name: '导出团队', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '导出团队角色', exact: true })
  await dialog.waitFor()
  assert.notEqual(
    await dialog.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgba(0, 0, 0, 0)',
  )
  assert.equal(await dialog.getByRole('checkbox').count(), 13)
  assert.equal(await dialog.locator('input:checked').count(), 13)
  await dialog.getByRole('button', { name: '清空选择', exact: true }).click()
  assert.equal(
    await dialog
      .getByRole('button', { name: '导出所选角色（0）', exact: true })
      .isDisabled(),
    true,
  )
  await dialog.getByRole('checkbox').first().check()
  assert.equal(
    await dialog
      .getByRole('button', { name: '导出所选角色（1）', exact: true })
      .isEnabled(),
    true,
  )
  await dialog.getByRole('combobox', { name: '选择团队', exact: true }).click()
  await page
    .getByRole('option', {
      name: 'writing · 跨项目通用（1 个角色）',
      exact: true,
    })
    .click()
  assert.equal(await dialog.getByRole('checkbox').count(), 1)
  assert.equal(await dialog.locator('input:checked').count(), 1)
  await dialog.getByRole('combobox', { name: '选择团队', exact: true }).click()
  await page
    .getByRole('option', {
      name: 'writing · Project A（13 个角色）',
      exact: true,
    })
    .click()
  assert.equal(await dialog.locator('input:checked').count(), 13)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  )
  await page.screenshot({ path: '/tmp/reflexion-team-export-mobile.png' })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 1200, height: 850 })
  const archive = {
    format: 'reflexion-team',
    version: 1,
    teamId: 'writing',
    roles: [
      {
        name: 'Writer',
        description: 'Write',
        systemPrompt: 'Use evidence.',
        domains: ['写作'],
        permissionCeiling: 'workspace-read',
        allowedTools: ['file.read'],
        canDelegate: false,
      },
      {
        name: 'Reviewer',
        description: 'Review',
        systemPrompt: 'Check evidence.',
        domains: [],
        permissionCeiling: 'workspace-write',
        allowedTools: ['file.read', 'file.write'],
        canDelegate: false,
      },
    ],
  }
  await page
    .locator('input[type="file"][accept*=".reflexion-team.json"]')
    .setInputFiles({
      name: 'writing.reflexion-team.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(archive)),
    })
  const preview = page.getByRole('dialog', {
    name: '导入团队：writing',
    exact: true,
  })
  await preview.waitFor()
  assert.equal(await page.evaluate(() => window.importedTeam), undefined)
  assert.equal(await preview.locator('details').count(), 2)
  await preview
    .getByRole('button', { name: '导入全部 2 个角色', exact: true })
    .click()
  await preview
    .getByText(
      '已导入 2 个角色，团队：writing。角色默认停用，可在角色库编辑后启用。',
      { exact: true },
    )
    .waitFor()
  const imported = await page.evaluate(() => window.importedTeam)
  assert.equal(imported.archive.roles.length, 2)
  assert.equal(imported.projectId, 'project')
  await preview.getByRole('button', { name: '关闭', exact: true }).click()
}
