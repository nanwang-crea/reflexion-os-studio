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
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  const imported = await page.evaluate(() => window.packageImported)
  assert.equal(imported.projectId, 'other')
  assert.equal(imported.digest, 'a'.repeat(64))
}
