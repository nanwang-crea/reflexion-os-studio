import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

const endpoint = new URL(process.argv[2] ?? 'http://127.0.0.1:19228')
assert.equal(endpoint.hostname, '127.0.0.1')
const output = resolve(
  process.argv[3] ?? join(tmpdir(), 'reflexion-cef-evidence'),
)
const expected = process.argv[4] ?? '人工接管验证'
const require = createRequire(
  new URL('../../apps/runtime/package.json', import.meta.url),
)
const { chromium } = require('playwright')
const browser = await chromium.connectOverCDP(endpoint.href)
const page = browser.contexts()[0].pages()[0]
// Run only after verify.mjs and native typing/pasting plus clicking 应用.
// Do not navigate: this assertion must observe the existing visible page.
const nativeInput = await page.getByRole('textbox').inputValue()
const nativeClick = await page.locator('output').innerText()
assert.equal(nativeInput, expected)
assert.equal(nativeClick, expected)
const resumed = `Agent 恢复：${nativeInput}`
await page.getByRole('textbox').fill(resumed)
await page.getByRole('button', { name: '应用', exact: true }).click()
assert.equal(await page.locator('output').innerText(), resumed)
await page.screenshot({ path: join(output, 'handoff.png') })
await writeFile(
  join(output, 'handoff.json'),
  JSON.stringify({ nativeInput, nativeClick, agentResume: resumed }, null, 2) +
    '\n',
)
console.log('Native handoff → existing page → Playwright resume passed')
process.exit(0)
