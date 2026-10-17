import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import { connectBrowserMcp } from '../../apps/runtime/dist/browser/agent/worker/connection.js'

// Explicit local experiment only; never attach to a user's normal browser.
const endpoint = new URL(process.argv[2] ?? 'http://127.0.0.1:19227')
assert.equal(endpoint.hostname, '127.0.0.1')
const output = resolve(
  process.argv[3] ?? join(tmpdir(), 'reflexion-cef-evidence'),
)
const require = createRequire(
  new URL('../../apps/runtime/package.json', import.meta.url),
)
const { chromium } = require('playwright')
await mkdir(output, { recursive: true })
let browser
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    browser = await chromium.connectOverCDP(endpoint.href, { timeout: 2000 })
    break
  } catch (error) {
    if (attempt === 29) throw error
    await setTimeout(500)
  }
}
const context = browser.contexts()[0]
assert.ok(context, 'CEF exposes its existing context')
const page = context.pages()[0]
assert.ok(page, 'CEF exposes its visible page')
const fixture = `<!doctype html><meta charset="utf-8"><title>Reflexion CEF validation</title>
<style>body{font:18px system-ui;padding:40px;background:#191c22;color:#edf0f5}
input,button{font:inherit;padding:12px;margin:8px}output{display:block;padding:16px}</style>
<h1>CEF · 共用页面验证</h1><label>测试输入<input aria-label="测试输入"></label>
<button onclick="document.querySelector('output').textContent=document.querySelector('input').value">应用</button>
<output aria-live="polite">等待输入</output><p>此页面仅含合成测试数据。</p>`
await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`)
await page
  .getByRole('textbox', { name: '测试输入' })
  .fill('Agent 输入：中文验证')
await page.getByRole('button', { name: '应用', exact: true }).click()
assert.equal(await page.locator('output').innerText(), 'Agent 输入：中文验证')
const session = await context.newCDPSession(page)
const version = await session.send('Browser.getVersion')
const tree = await session.send('Accessibility.getFullAXTree')
assert.ok(tree.nodes.some((node) => node.name?.value === '应用'))
const mcp = await connectBrowserMcp(context, output)
try {
  const snapshot = await mcp.client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  })
  assert.notEqual(snapshot.isError, true)
  assert.ok(JSON.stringify(snapshot.content).includes('测试输入'))
} finally {
  await Promise.allSettled([mcp.client.close(), mcp.server.close()])
}
await page.screenshot({ path: join(output, 'cef-playwright.png') })
await writeFile(
  join(output, 'result.json'),
  JSON.stringify(
    {
      version,
      checks: [
        'existing-context',
        'visible-page',
        'navigation',
        'chinese-fill',
        'role-click',
        'accessibility',
        'screenshot',
        'existing-official-mcp-snapshot',
      ],
      pageTitle: await page.title(),
    },
    null,
    2,
  ) + '\n',
)
await session.detach()
console.log(`CEF Playwright checks passed; evidence: ${output}`)
// Disconnect without closing the user's experiment window.
process.exit(0)
