import assert from 'node:assert/strict'

export async function verifyRoleLayouts(page) {
  await page.evaluate(() => {
    const names = [
      'Research Agent',
      'Review Agent',
      'Worker Agent',
      '写作助手',
      '数据分析',
      '项目审校',
      '文档整理',
    ]
    window.setRoleTemplates(
      names.map((name, index) => ({
        id: `layout-${index}`,
        updatedAt: '2026-10-15T00:00:00Z',
        name,
        description: [
          '并行检索项目或公开资料并归纳证据。',
          '独立审查实现、风险与遗漏，不执行修改。',
          '按任务要求完成实现并验证结果。',
        ][index % 3],
        systemPrompt: 'Follow the task.',
        domains: index < 3 ? [] : ['开发'],
        projectId: index === 5 ? 'project' : null,
        modelBinding: { mode: 'inherit' },
        source: index < 3 ? 'builtin' : 'user',
        builtin: index < 3,
        enabled: true,
        policy: {
          permissionCeiling: 'workspace-read',
          allowedTools: ['file.read'],
          canDelegate: index === 0,
        },
      })),
    )
    window.showRoleLayout()
  })
  await page.locator('.agent-role-card').nth(6).waitFor()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    )
    await page.setViewportSize({ width: 1440, height: 900 })
    const bounds = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.agent-role-card')].map(
        (el) => el.getBoundingClientRect(),
      )
      const heading = document
        .querySelector('.agent-roles-heading')
        .getBoundingClientRect()
      const topbar = document.querySelector('.topbar').getBoundingClientRect()
      const inputs = [
        ...document.querySelectorAll('.agent-role-filters label'),
      ].map((el) => el.getBoundingClientRect())
      return {
        bottom: rows.at(-1).bottom,
        columns: getComputedStyle(
          document.querySelector('.agent-role-list'),
        ).gridTemplateColumns.split(' ').length,
        headingTop: heading.top,
        barBottom: topbar.bottom,
        filterTops: inputs.map((rect) => rect.top),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    assert.equal(bounds.overflow, false)
    assert.ok(bounds.bottom < 900, `Seven roles must fit: ${bounds.bottom}`)
    assert.equal(
      bounds.columns,
      3,
      'Wide windows show three role cards per row',
    )
    assert.ok(
      bounds.headingTop >= bounds.barBottom,
      'Page heading must not overlap topbar',
    )
    assert.equal(
      new Set(bounds.filterTops).size,
      1,
      'Desktop filters stay in one row',
    )
    await page.mouse.move(0, 0)
    await page.screenshot({
      animations: 'disabled',
      path: `/tmp/reflexion-roles-compact-${theme}.png`,
    })
  }
  for (const width of [1000, 768, 390]) {
    await page.setViewportSize({ width, height: 850 })
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    )
    assert.equal(
      await page
        .locator('.agent-role-list')
        .evaluate(
          (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
        ),
      width === 390 ? 1 : 2,
    )
    await page.mouse.move(0, 0)
    await page.screenshot({
      animations: 'disabled',
      path: `/tmp/reflexion-roles-compact-${width}.png`,
    })
  }
  await page
    .locator('.agent-role-card')
    .first()
    .getByRole('button', { name: '复制并配置' })
    .click()
  await page.getByRole('dialog', { name: '新建角色', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await page
    .getByRole('dialog', { name: '新建角色', exact: true })
    .waitFor({ state: 'hidden' })
  await page.evaluate(() => delete document.documentElement.dataset.theme)
  await page.setViewportSize({ width: 1200, height: 850 })
}
