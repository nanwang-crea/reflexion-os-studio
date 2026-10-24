import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function verifyConfirmationDialog(page) {
  await page.getByRole('button', { name: '打开确认框', exact: true }).click()
  await page.locator('.confirm-dialog-modal[open]').waitFor()
  const bounds = await page.locator('.dialog').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return {
      left: rect.left + el.clientLeft,
      right: rect.left + el.clientLeft + el.clientWidth,
      children: Array.from(el.children).map((child) => {
        const rect = child.getBoundingClientRect()
        return { left: rect.left, right: rect.right }
      }),
    }
  })
  // WebKit scrollWidth 包含被经典滚动条占用的尾部 padding；检查实际内容边界。
  assert.ok(
    bounds.children.every(
      (child) => child.left >= bounds.left && child.right <= bounds.right,
    ),
    JSON.stringify(bounds),
  )
  if (process.env.UI_REVIEW_OUTPUT)
    await page.screenshot({
      path: join(process.env.UI_REVIEW_OUTPUT, 'confirmation.png'),
    })
  await page.getByRole('button', { name: '取消', exact: true }).click()
}
