import assert from 'node:assert/strict'

export async function verifyQuestions(page) {
  await page.evaluate(() => window.showQuestions())
  for (const height of [850, 600, 450]) {
    await page.setViewportSize({ width: 600, height })
    const bounds = await page.evaluate(() => {
      const body = document.querySelector('.user-question-body')
      const chat = document
        .querySelector('.chat-scroll')
        .getBoundingClientRect()
      const card = document
        .querySelector('.user-question-card')
        .getBoundingClientRect()
      const actions = document
        .querySelector('.user-question-actions')
        .getBoundingClientRect()
      return {
        scrollable: body.scrollHeight > body.clientHeight,
        chatHeight: chat.height,
        chatBottom: chat.bottom,
        cardTop: card.top,
        cardHeight: card.height,
        actionsBottom: actions.bottom,
      }
    })
    assert.ok(bounds.scrollable)
    assert.ok(bounds.chatHeight > 70)
    assert.ok(bounds.cardHeight <= height * 0.45 + 1)
    assert.ok(bounds.chatBottom <= bounds.cardTop)
    assert.ok(bounds.actionsBottom < height)
  }
  await page.locator('.user-question-body').hover()
  await page.mouse.wheel(0, 350)
  await page.waitForFunction(
    () => document.querySelector('.user-question-body').scrollTop > 0,
  )
  await page.getByText('选择2-2', { exact: true }).click()
  assert.ok(
    (await page.locator('.user-question-body').evaluate((el) => el.scrollTop)) >
      0,
  )
  await page.getByRole('button', { name: '收起问题', exact: true }).click()
  assert.equal(await page.locator('.user-question-body').isVisible(), false)
  await page.getByText('实际对话正文', { exact: true }).waitFor()
  await page.getByRole('button', { name: '展开问题', exact: true }).click()
  assert.equal(await page.getByRole('radio').last().isChecked(), true)
  await page.getByRole('button', { name: '提交回答', exact: true }).click()
  await page.waitForFunction(() => window.questionAnswers?.length === 1)
  assert.equal(
    (await page.evaluate(() => window.questionAnswers[0])).questionId,
    'q2',
  )
  await page.screenshot({ path: '/tmp/reflexion-question-scroll.png' })
}
