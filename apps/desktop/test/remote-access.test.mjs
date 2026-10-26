import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { browserWorkerPaths } from '../../runtime/dist/browser/agent/paths.js'
import { harness } from '../../runtime/test/access/helpers.mjs'
const require = createRequire(
  new URL('../../runtime/package.json', import.meta.url),
)
process.env.PLAYWRIGHT_BROWSERS_PATH = browserWorkerPaths().browsers
const { chromium } = require('playwright')
const webRoot = fileURLToPath(new URL('../dist-frontend', import.meta.url))

// A real browser consumes the built shared ChatView over the real HTTPS boundary.
test('phone browser pairs, restores stream after reload, sends into the same session and handles revocation', async (t) => {
  const h = await harness(t, webRoot)
  h.bus.publish(
    h.event('message.delta', {
      messageId: h.message.id,
      chunkSeq: 0,
      delta: '手机同步中的回复',
    }),
  )
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(h.status.invitationUrl)
  await page.getByRole('button', { name: '请求连接', exact: true }).click()
  await page
    .getByText('等待电脑确认。批准后可查看、发送消息并处理此会话审批。')
    .waitFor()
  assert.equal(new URL(page.url()).hash, '')
  const device = h.service.status().devices[0]
  await page.getByText(device.verificationCode, { exact: true }).waitFor()
  h.service.resolve(device.id, true)
  await page.getByText('已连接电脑', { exact: true }).waitFor()
  await page.getByText('手机同步中的回复', { exact: true }).waitFor()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  )
  assert.equal(overflow, false)
  await mkdir('/tmp/reflexion-mobile-qa', { recursive: true })
  await page.screenshot({
    path: '/tmp/reflexion-mobile-qa/phone-chat.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 320, height: 700 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await page.setViewportSize({ width: 390, height: 844 })
  const lease = {
    sessionId: h.session.id,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    enforcement: 'credential-guard',
    provider: 'seatbelt',
  }
  h.context.danger.leaseFor = () => lease
  await page.reload()
  await page.getByText('手机同步中的回复', { exact: true }).waitFor()
  await page.getByRole('status', { name: '危险访问已启用' }).waitFor()
  h.context.danger.leaseFor = () => null
  h.bus.publish(
    h.event('danger.changed', {
      scope: 'session',
      sessionId: h.session.id,
      lease: null,
      reason: 'user-disabled',
    }),
  )
  await page
    .getByRole('status', { name: '危险访问已启用' })
    .waitFor({ state: 'hidden' })
  await page.locator('textarea').fill('从手机发送的消息')
  await page.locator('textarea').press('Enter')
  await page.waitForFunction(
    () => document.querySelector('textarea')?.value === '',
  )
  const sent = h.calls.find((call) => call.method === 'message.send')
  assert.equal(sent.params.sessionId, h.session.id)
  assert.equal(sent.params.content, '从手机发送的消息')
  assert.ok(sent.params.requestId.startsWith(`device:${device.id}:`))
  h.service.revoke(device.id)
  await page
    .getByText('连接中断，正在重连；电脑需保持运行', { exact: true })
    .waitFor()
  assert.deepEqual(errors, [])
})
