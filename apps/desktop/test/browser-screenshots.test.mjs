import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'browser-screenshots-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const outfile = join(dir, 'screenshots.mjs')
await build({
  absWorkingDir: root,
  entryPoints: ['frontend/features/chat/images/BrowserScreenshotResults.tsx'],
  bundle: true,
  jsx: 'automatic',
  format: 'esm',
  platform: 'node',
  loader: { '.css': 'empty' },
  outfile,
})
const { BrowserScreenshotResults } = await import(pathToFileURL(outfile).href)
test('browser screenshots display canonical assets only and bind thumbnails to the execution run', () => {
  const call = {
    toolName: 'browser.execute',
    runId: 'run',
    output: {
      provenance: { kind: 'web' },
      resourceLinks: Array.from({ length: 6 }, (_, i) => ({
        kind: 'asset',
        assetId: 'a' + i,
      })),
    },
  }
  const node = BrowserScreenshotResults({ call })
  assert.equal(node.props['aria-label'], '浏览器截图')
  assert.equal(node.props.children.length, 4)
  assert.equal(node.props.children[0].props.expectedRunId, 'run')
  assert.equal(
    BrowserScreenshotResults({ call: { ...call, toolName: 'other' } }),
    null,
  )
  assert.equal(
    BrowserScreenshotResults({
      call: { ...call, output: { ...call.output, provenance: null } },
    }),
    null,
  )
})
