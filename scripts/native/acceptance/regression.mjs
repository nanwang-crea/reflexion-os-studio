// Trusted debug harness only. Operates synthetic user pages in this test app,
// outside the Agent's scoped MCP context, without reading personal browser data.
import assert from 'node:assert/strict'
import { chromium } from '../../../apps/runtime/node_modules/playwright/index.mjs'
import { setTimeout } from 'node:timers/promises'
async function until(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await setTimeout(50)
  }
  throw new Error('native regression timed out')
}
export async function runRegression(endpoint, url, progress) {
  await progress('await-user-browser', { url })
  let browser
  const reconnect = async () => {
    await browser?.close()
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true })
    return browser.contexts().flatMap((context) => context.pages())
  }
  try {
    await until(
      async () => (await reconnect()).find((page) => page.url() === url),
      180000,
    )
    const rounds = 30
    for (let round = 0; round < rounds; round++) {
      const user = (await reconnect()).find((page) =>
        page.url().startsWith(url),
      )
      assert.ok(user)
      await user.goto(`${url}?search=${round}`)
      await user.locator('#native-popup').click()
      const popup = await until(async () =>
        (await reconnect()).find((page) =>
          page.url().includes('/native-result'),
        ),
      )
      await popup.waitForLoadState('domcontentloaded')
      await popup.goto(`${url}?result=${round}`)
      await popup.reload()
      await popup.close()
      if ((round + 1) % 5 === 0)
        await progress('native-navigation', { completed: round + 1, rounds })
    }
    const user = (await reconnect()).find((page) => page.url().startsWith(url))
    await user.goto(url)
    await progress('await-download-cancel', { rounds, url })
    await user.locator('#native-download').click()
    await progress('native-regression-ready', { rounds, url })
    return { rounds }
  } finally {
    await browser?.close()
  }
}
